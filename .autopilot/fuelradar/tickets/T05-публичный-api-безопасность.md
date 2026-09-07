# 05 — Публичный API и безопасность

**Требования:** R06, R21, R23, R26, R32, R63, R65, R66, R67, R82, R92, R95i, A02
**Blocked by:** 03, 04
**Зона:** `backend/app/api/`, `backend/app/auth/`
**Волна:** 5
**Status:** ready

## Что должно заработать

FastAPI, namespace `/api/v1`: `GET /stations` (список с фильтрами: lat/lon/radius, city,
brand, fuel, status, confidence_min, queue_max, bbox; пагинация), `GET /stations/{id}`,
`GET /stations/{id}/fuel`, `GET /stations/{id}/history`, `GET /stations/nearby`,
`GET /meta` (A02 — справочники и переводы статусов), избранное (POST/DELETE
`/favorites/{station_id}`, GET списка), monitoring-zones CRUD, admin: `GET /admin/sources`,
`GET /admin/sources/{id}/health`, `POST /admin/sources/{id}/refresh` (ставит задание воркеру T06),
`POST /admin/stations/{id}/merge`/`split` (T03). Разбор статуса «почему» (источники + вклады)
в ответе станции (R92). Безопасность: карта анонимна (R65); персонализация — JWT в
httpOnly-cookie; dev-вход + magic-link (активируется SMTP_URL); админ — X-Admin-Token
(R95i); rate limiting; CORS-белый список; валидация Pydantic (R67); кэш карты/bbox (R82).

## Из брифа, дословно

> «GET /stations … filters: lat, lon, radius, city, brand, fuel, status, confidence_min, queue_max»
> «Для просмотра карты регистрация может быть необязательной»
> «Вход: Telegram + email magic-link» (механизмы активируются ключами; без ключей — дев-вход)
> «HTTPS, secure cookies / JWT, rate limiting, CORS, защита административного API, валидация входных данных, журналирование действий администратора»

## Разделы спецификации

Истории §14 №1–3/8/10, §15 №1–10, §10 (score_breakdown в ответе), §12 №5 (кэш).

## Критерии приёмки

- [ ] `/stations/nearby` с bbox/радиусом возвращает станции с текущими статусами и score (быстро, кэш)
- [ ] Фильтры валидируются: неверные координаты/статусы → 422 с текстом на русском
- [ ] Аноним видит карту/список/карточку; избранное/зоны — только с профилем (401)
- [ ] Гость/пользователь не могут вызвать admin-endpoints (401/403); X-Admin-Token из .env
- [ ] Вход: dev-вход работает; magic-link отправляется при SMTP_URL (иначе «не настроено»)
- [ ] `POST /admin/sources/{id}/refresh` создаёт задание (через worker T06) и возвращает его id
- [ ] `/meta` отдаёт топливо, сети, статусы с переводами
- [ ] Ответ станции содержит `status_explanation` (источники: «Источник A — 12 минут назад»)
- [ ] Тесты: контракты endpoints, права (401/403), валидация, кэш

## Швы для тестов

Публичный API через TestClient (integration); сценарии §126–128 — API-E2E (швы §20).