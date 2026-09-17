"""M16 — CLI roles: выдача/снятие ролей для эксплуатации пилота.

Использует session-scope БД conftest: пользователь по уникальному email,
проверки идемпотентности и защита последнего ADMIN.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from app.db.models import AdminActionLog, User
from app.db.session import init_db


@pytest.fixture(scope="module", autouse=True)
def _db() -> None:
    init_db()


@pytest.fixture()
def operator_candidate(db_session) -> User:
    user = User(display_name="Кандидат OPERATOR", email="roles-cli-operator@example.com", role="USER")
    db_session.add(user)
    db_session.commit()
    return user


def _role_changes(db_session, user_id: int) -> list[AdminActionLog]:
    return list(
        db_session.scalars(
            select(AdminActionLog)
            .where(AdminActionLog.action == "role_change", AdminActionLog.target_id == str(user_id))
            .order_by(AdminActionLog.id)
        )
    )


def test_set_promotes_user_to_operator(db_session, operator_candidate, capsys) -> None:
    from cli.roles import main

    code = main(["set", "--user", operator_candidate.email, "--role", "OPERATOR"])
    out = capsys.readouterr().out
    assert code == 0
    db_session.refresh(operator_candidate)
    assert operator_candidate.role == "OPERATOR"
    assert "OPERATOR" in out
    # Аудит: одна запись role_change с from/to (пароля и лишнего тут нет по определению).
    changes = _role_changes(db_session, operator_candidate.id)
    assert len(changes) == 1
    assert changes[0].payload["from"] == "USER"
    assert changes[0].payload["to"] == "OPERATOR"
    assert changes[0].actor == "cli"


def test_set_by_numeric_id_and_idempotent_repeat(db_session, operator_candidate, capsys) -> None:
    from cli.roles import main

    assert main(["set", "--user", str(operator_candidate.id), "--role", "ADMIN"]) == 0
    db_session.refresh(operator_candidate)
    assert operator_candidate.role == "ADMIN"

    # Повтор той же роли — no-op без второй записи аудита.
    code = main(["set", "--user", str(operator_candidate.id), "--role", "ADMIN"])
    out = capsys.readouterr().out
    assert code == 0
    assert "уже роль" in out
    assert len(_role_changes(db_session, operator_candidate.id)) == 1

    # Обратно в USER — второй ADMIN в системе есть, понижение разрешено.
    assert main(["set", "--user", str(operator_candidate.id), "--role", "USER"]) == 0
    db_session.refresh(operator_candidate)
    assert operator_candidate.role == "USER"


def test_set_rejects_demoting_last_admin(db_session, capsys) -> None:
    from cli.roles import main

    # Единственный ADMIN в session-scope БД создан в test_security/test_api
    # через bootstrap; ищем его динамически, не полагаясь на конкретный id.
    admin = db_session.scalar(select(User).where(User.role == "ADMIN").order_by(User.id))
    if admin is None:
        pytest.skip("no admin in shared session db")
    others = db_session.scalars(select(User).where(User.role == "ADMIN", User.id != admin.id)).all()
    for other in others:
        other.role = "USER"
    db_session.commit()

    code = main(["set", "--user", str(admin.id), "--role", "USER"])
    err = capsys.readouterr().err
    assert code == 2
    assert "последний ADMIN" in err
    db_session.refresh(admin)
    assert admin.role == "ADMIN"  # не изменился


def test_set_unknown_user_and_invalid_role(db_session, capsys) -> None:
    from cli.roles import main

    assert main(["set", "--user", "nobody@example.com", "--role", "OPERATOR"]) == 2
    assert "не найден" in capsys.readouterr().err

    assert main(["set", "--user", "roles-cli-operator@example.com", "--role", "SUPERUSER"]) == 2
    assert "роль должна быть одной из" in capsys.readouterr().err


def test_list_shows_roles(db_session, operator_candidate, capsys) -> None:
    from cli.roles import main

    assert main(["list"]) == 0
    out = capsys.readouterr().out
    assert operator_candidate.email in out
    assert "OPERATOR" in out or "USER" in out
