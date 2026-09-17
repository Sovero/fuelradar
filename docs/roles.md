# Управление ролями пользователей (M16 RBAC)

Кто что может в FuelRadar:

| Роль | Права |
|------|-------|
| `USER` | Карта/список/фильтры (публично, без входа), персональные разделы: избранное, зоны мониторинга, правила уведомлений, отчёты «Сообщить» |
| `OPERATOR` | Всё, что USER, плюс **чтение** админки: источники и их health, журнал сборок, покрытие, очередь дедупликации, отчёты пользователей |
| `ADMIN` | Всё, что OPERATOR, плюс **мутации**: refresh источника, merge/split станций, подтверждение слияний, блокировка/разблокировка пользователей |

Публичная часть и read-only карта анонимны — вход нужен только для персональных разделов и админки.

## Как пользователь получает роль

- **Первый `ADMIN`** — через мастер первоначальной настройки: при первом открытии
  интерфейса, пока в БД нет ни одного ADMIN, появляется форма (имя/email/пароль).
  Механизм одноразовый: после создания первого администратора повторный bootstrap
  возвращает 409, окно настройки больше не открывается.
- **`USER`** — присваивается автоматически любому, кто входит через Telegram,
  magic-link или dev-вход (в DEBUG-окружении).
- **`OPERATOR`/последующие `ADMIN`** — выдаёт существующий ADMIN: CLI-инструментом
  (ниже). Веб-интерфейса смены ролей в админке пока нет — только блокировка
  пользователей (`/admin` → Пользователи).

## CLI: `python -m cli.roles`

Запускается на машине с backend-окружением (тот же `.env`, та же БД, что и API):

```bash
cd backend

# список пользователей: id, роль, статус, контакт
python -m cli.roles list

# выдать роль (по email или по id)
python -m cli.roles set --user operator@example.com --role OPERATOR
python -m cli.roles set --user 12 --role ADMIN

# вернуть USER
python -m cli.roles set --user operator@example.com --role USER
```

Поведение и защита:

- роль — одна из `USER`, `OPERATOR`, `ADMIN`;
- повторная установка той же роли — no-op, лишних записей в аудите не оставляет;
- **последнего ADMIN понизить нельзя** — CLI вернёт ошибку: bootstrap одноразовый,
  и администратора будет некому вернуть;
- каждая смена пишется в `admin_action_log` (`actor="cli"`, `action="role_change"`,
  с полями `from`/`to`) — единый журнал с действиями через API;
- смена применяется **сразу**: `require_admin`/`require_operator` перечитывают
  пользователя из БД на каждый запрос — перезапускать api/worker не нужно;
- заблокированный пользователь (`POST /admin/users/{id}/block`) теряет доступ
  к персональным разделам и админке немедленно, независимо от роли.

В Docker (контейнер `api`) то же самое:

```bash
docker compose exec api python -m cli.roles list
docker compose exec api python -m cli.roles set --user operator@example.com --role OPERATOR
```

## Операционные сценарии пилота

**Выдать оператору доступ к мониторингу источников:**

```bash
python -m cli.roles list                                  # найти id/email
python -m cli.roles set --user anna@example.com --role OPERATOR
```

Оператор заходит обычным входом (пароль, Telegram, magic-link) и видит вкладки
админки в режиме чтения.

**Выдать второго ADMIN (перед отпуском/сменой ответственного):**

```bash
python -m cli.roles set --user boris@example.com --role ADMIN
# после передачи обязанностей — безопасно вернуть прежнего:
python -m cli.roles set --user anna@example.com --role USER
```

**Проверить, у кого какие роли (аудит вручную):**

```bash
python -m cli.roles list
# журнал смен ролей — в БД:
#   SELECT created_at, actor, payload FROM admin_action_log WHERE action='role_change';
```

Если единственный ADMIN недоступен (заблокирован, уволился, потерял пароль) —
восстановление только через прямой доступ к БД, поэтому выдавайте второго
ADMIN заранее.

## Связанные материалы

- Модель входа и bootstrap — `backend/app/auth/service.py`, `backend/app/api/login.py`
- RBAC-зависимости — `backend/app/api/deps.py` (`require_user`/`require_operator`/`require_admin`)
- CLI-инструмент — `backend/cli/roles.py`
- Аудит действий — таблица `admin_action_log`
