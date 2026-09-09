# 14 — Realtime, Web Push и доставка уведомлений

**Требования:** R64, R97i
**Blocked by:** 07, 09, 12, 13
**Зона:** `backend/app/realtime/`, `backend/app/alerts/`, `backend/app/db/`, `backend/app/api/`, `backend/app/main.py`, `backend/tests/`, `frontend/lib/hooks/`, `frontend/components/settings/`, `frontend/public/sw.js`, `frontend/lib/types.ts`, `frontend/lib/i18n.ts`, `backend/pyproject.toml`, `.env.example`
**Волна:** 11
**Status:** ready

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

- [ ] SSE отдаёт heartbeat и новую revision/станцию при изменении наблюдений; соединение корректно закрывается
- [ ] Клиент подписывается, переподтягивает станции и сохраняет старые данные при обрыве
- [ ] PushSubscription CRUD требует профиль и валидирует endpoint/p256dh/auth
- [ ] Service worker показывает push и по клику открывает карточку станции
- [ ] VAPID transport отправляет всем активным подпискам, удаляет 404/410, ошибки изолированы
- [ ] Telegram mock доказывает Bot API вызов; без ключей/получателя — явный статус, не 500
- [ ] Private keys/token не возвращаются API, не хранятся в БД и не логируются
- [ ] Добавленная зависимость Web Push обоснована и зафиксирована lock-файлом; backend/frontend тесты проходят
