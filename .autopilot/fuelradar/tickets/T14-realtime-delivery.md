# 14 — Realtime, Web Push и доставка уведомлений

**Требования:** R64, R97i
**Blocked by:** 07, 09, 12, 13
**Зона:** `backend/app/realtime/`, `backend/app/alerts/`, `backend/app/db/`, `backend/app/api/`, `backend/app/main.py`, `backend/tests/`, `frontend/lib/hooks/`, `frontend/components/settings/`, `frontend/public/sw.js`, `frontend/lib/types.ts`, `frontend/lib/i18n.ts`, `backend/pyproject.toml`, `.env.example`
**Волна:** 11
**Status:** done

## Что должно заработать

Карта получает сигнал об изменениях через SSE и обновляет канонические данные без
ручной перезагрузки. Пользователь может создать/удалить браузерную push-подписку;
при наличии VAPID-ключей событие реально отправляется. Telegram остаётся реальным
Bot API каналом. Секреты живут только в env.

## Из брифа, дословно

> «Клиент может получать изменения посредством WebSocket или Server-Sent Events»
> «Предусмотреть: Web Push; Telegram; внутри приложения»
> «На первом этапе оптимально: PWA Push + Telegram»

## Разделы спецификации

§25, §13, §15, §18, швы SSE/public subscription API/alerts channels.

## Критерии приёмки

- [x] SSE отдаёт heartbeat и новую revision/станцию при изменении наблюдений; соединение корректно закрывается — `GET /api/v1/realtime/stream` (`backend/app/realtime/router.py`): начальное `revision` сразу, далее сигнал при изменении `data_revision` (max-id станций/наблюдений, append-only R17), heartbeat `: ping` ~15 с, `bye` + `Last-Event-ID` при ротации, предохранитель `sse_max_clients`; проверено живым curl-стримом (вставка станции → событие в потоке)
- [x] Клиент подписывается, переподтягивает станции и сохраняет старые данные при обрыве — `useRealtime` + HomeScreen: событие → `refetch()` обычного кэшируемого GET (R82); при error данные на экране не трогаются, EventSource переподключается сам; честный индикатор «live-канал потерян»
- [x] PushSubscription CRUD требует профиль и валидирует endpoint/p256dh/auth — `GET/POST/DELETE /push/subscriptions` (`api/personal.py`, 401 без профиля): endpoint только https, keys обязательны и проверяются как base64url, POST идемпотентен по endpoint (ротация ключей обновляет строку), чужую подписку удалить нельзя (404)
- [x] Service worker показывает push и по клику открывает карточку станции — `sw.js`: `push` → `showNotification` (title/body/station_id из payload, tag по станции), `notificationclick` → фокус существующего окна / открытие `/?station=<id>`
- [x] VAPID transport отправляет всем активным подпискам, удаляет 404/410, ошибки изолированы — `alerts/channels.py::_send_web_push`: pywebpush (RFC 8291/8292), ошибка одной подписки не отменяет остальные, 404/410 → `is_active=false` + `last_error=gone:<code>`, успех → `last_success_at`
- [x] Telegram mock доказывает Bot API вызов; без ключей/получателя — явный статус, не 500 — контракт T07 сохранён (`test_telegram_channel_contract_unchanged`)
- [x] Private keys/token не возвращаются API, не хранятся в БД и не логируются — `PushSubscriptionOut` без keys; `/meta` отдаёт только публичный VAPID public key и `push.enabled`; приватный ключ/токен только в .env (R68)
- [x] Добавленная зависимость Web Push обоснована и зафиксирована — `pywebpush>=2.0` в `backend/requirements.txt` (реальная доставка Web Push Protocol); backend 191 passed + ruff, frontend 96 passed + typecheck + build
