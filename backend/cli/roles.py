"""CLI `roles` — управление ролями пользователей (M16 RBAC, эксплуатация пилота).

Примеры:
    python -m cli.roles list
    python -m cli.roles set --user operator@example.com --role OPERATOR
    python -m cli.roles set --user 12 --role USER

Роль принимает одно из значений USER/OPERATOR/ADMIN (`app.auth.service.USER_ROLES`).
Каждая смена пишется в admin_action_log (actor="cli") — аудит действий единый с API.
Понизить последнего ADMIN нельзя: одноразовый bootstrap уже закрыт, вход без
администратора не восстановить.

Смена роли применяется сразу: require_admin/require_operator перечитывают
пользователя из БД на каждый запрос, перезапуск не нужен.
"""

from __future__ import annotations

import argparse
import sys

from app.auth.service import USER_ROLES


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="roles", description="Просмотр и смена ролей пользователей (M16 RBAC)")
    sub = p.add_subparsers(dest="command", required=True)

    sub.add_parser("list", help="список пользователей с ролями")

    set_cmd = sub.add_parser("set", help="назначить роль пользователю")
    set_cmd.add_argument("--user", required=True, help="id пользователя или email")
    set_cmd.add_argument("--role", required=True, help=f"одна из: {', '.join(sorted(USER_ROLES))}")
    return p


def _find_user(session, ref: str):
    """Пользователь по числовому id или по email (регистр не важен)."""
    from sqlalchemy import select

    from app.db.models import User

    if ref.isdigit():
        return session.get(User, int(ref))
    return session.scalar(select(User).where(User.email == ref.strip().lower()).limit(1))


def _cmd_list(session) -> int:
    from sqlalchemy import select

    from app.db.models import User

    users = session.scalars(select(User).order_by(User.id)).all()
    if not users:
        print("Пользователей нет — первый ADMIN создаётся через мастер первоначальной настройки (/auth/bootstrap).")
        return 0
    print(f"{'id':>4}  {'роль':8}  {'статус':11}  контакт")
    for u in users:
        contact = u.email or (f"telegram:{u.telegram_id}" if u.telegram_id else "—")
        status = "ЗАБЛОКИРОВАН" if u.is_blocked else "активен"
        print(f"{u.id:>4}  {u.role:8}  {status:11}  {contact}")
    return 0


def _cmd_set(session, ref: str, role: str) -> int:
    from app.db.models import AdminActionLog

    role = role.strip().upper()
    if role not in USER_ROLES:
        print(f"ошибка: роль должна быть одной из {', '.join(sorted(USER_ROLES))}", file=sys.stderr)
        return 2

    user = _find_user(session, ref)
    if user is None:
        print(f"ошибка: пользователь «{ref}» не найден (см. python -m cli.roles list)", file=sys.stderr)
        return 2

    if user.role == role:
        print(f"У пользователя #{user.id} ({user.email or user.telegram_id}) уже роль {role} — ничего не изменено.")
        return 0

    if user.role == "ADMIN" and role != "ADMIN":
        from sqlalchemy import func, select

        from app.db.models import User

        admins = session.scalar(select(func.count()).select_from(User).where(User.role == "ADMIN"))
        if admins <= 1:
            print(
                "ошибка: это последний ADMIN — понизить нельзя (bootstrap одноразовый, "
                "администратора больше некому назначить). Сначала создайте второго ADMIN.",
                file=sys.stderr,
            )
            return 2

    old_role = user.role
    user.role = role
    session.add(
        AdminActionLog(
            actor="cli",
            action="role_change",
            target_type="user",
            target_id=str(user.id),
            payload={"from": old_role, "to": role, "email": user.email},
        )
    )
    session.commit()
    print(f"Готово: #{user.id} ({user.email or user.telegram_id}): {old_role} → {role}. Применяется сразу, без перезапуска.")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    from app.db.session import SessionLocal, init_db

    init_db()
    with SessionLocal() as session:
        if args.command == "list":
            return _cmd_list(session)
        if args.command == "set":
            return _cmd_set(session, args.user, args.role)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
