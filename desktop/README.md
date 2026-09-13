# FuelRadar Desktop

Windows-приложение (Electron) поверх того же веб-интерфейса: установщик NSIS,
автообновление через electron-updater, вход через Telegram.

## Архитектура

```
┌─ FuelRadar.exe (Electron) ──────────────────────────────┐
│  окно → http://127.0.0.1:<прокси-порт>                  │
│  reverse-proxy (аналог deploy/Caddyfile из прода):      │
│    /api/* → backend (FUELRADAR_API_URL / config.json),  │
│             Origin переписывается (R66, иначе 403);     │
│    /*     → встроенный Next standalone (server-dist)    │
└──────────────────────────────────────────────────────────┘
```

- Встроенный интерфейс: `desktop/server-dist` — production-сборка Next.js
  (`NEXT_OUTPUT=standalone`), запускается самим Electron
  (`ELECTRON_RUN_AS_NODE=1`) на свободном 127.0.0.1-порту.
- `frontend/next.config.mjs` включат `output: "standalone"` только при
  `NEXT_OUTPUT=standalone` — обычный `npm run build` в `frontend/` не меняется.
- Next печёт rewrites в момент сборки, поэтому `API_INTERNAL_URL` в рантайме
  не читается — вместо этого Electron проксирует `/api/*` на backend (как
  Caddy в проде) и переписывает `Origin` на origin API: иначе любой
  POST/PUT/PATCH/DELETE получает 403 «Недопустимый источник запроса» (R66).

## Сборка

```bash
cd desktop
npm install
npm run dist        # → dist/FuelRadar-Setup-<версия>.exe + latest.yml + .blockmap
npm run smoke       # быстрая проверка: окно + сервер + прокси (нужен backend на :8000)
```

`npm run dist` сам: рисует `build/icon.ico` из `frontend/public/icon.svg`,
собирает standalone и упаковывает NSIS-установщик. Артефакты (`dist/`,
`server-dist/`, `build/`) не коммитятся — см. `.gitignore`.

## Backend для установленного приложения

По умолчанию оболочка ходит на `http://127.0.0.1:8000` (пилот/разработка).
Для «установил и работает» задайте адрес одним из способов (приоритет сверху):

1. переменная окружения `FUELRADAR_API_URL` (системная или из ярлыка);
2. `%APPDATA%\FuelRadar\config.json` (путь = `app.getPath("userData")`):

```json
{ "apiBaseUrl": "https://api.example.com" }
```

Адрес — данные, не код (R04/R81): регион/сервер не зашиты в приложение.

## Вход через Telegram (R66/R97i)

- Backend: `TELEGRAM_BOT_TOKEN` в `.env` — без него `POST /auth/telegram`
  честно отвечает «не настроено» (R97i), приложение не падает.
- Frontend: `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` в `frontend/.env.local` —
  публичное имя бота для виджета; имя не секрет, токен на фронт не попадает.
- Оболочка: виджет грузится с `telegram.org`, открывает popup
  `oauth.telegram.org` — такие попапы разрешены дочерними окнами
  (`desktop/main.cjs`), остальные внешние ссылки уходят в системный браузер,
  `tg://` — в Telegram-клиент. Cookie-сессия живёт в профиле пользователя.

## Автообновление

- `electron-updater`, NSIS, `autoDownload` + установка при выходе; проверка
  при старте и раз в 4 часа; уведомление «обновление загружено».
- Фид — **Releases приватного репозитория** `Sovero/fuelradar`
  (`build.publish` = `provider: github`); owner/repo запекаются при сборке в
  `resources/app-update.yml`. Публикация релиза:
  ```
  gh release create vX.Y.Z dist/FuelRadar-Setup-X.Y.Z.exe \
    dist/FuelRadar-Setup-X.Y.Z.exe.blockmap dist/latest.yml
  ```
- **Токен фида** (репозиторий приватный): fine-grained PAT с единственным
  правом **Contents: Read-only** только для этого репозитория
  (<https://github.com/settings/personal-access-tokens/new>). Положите его в
  `desktop/.update-feed-token` (в git не попадает, см. .gitignore) **перед**
  сборкой — afterPack (`scripts/patch-feed-token.cjs`) упакует его в
  `resources/update-feed-token`.
- В рантайме `main.cjs` читает токен и переключает фид на
  `setFeedURL({provider:"github", private:true, token})` →
  PrivateGitHubProvider работает через **api.github.com** (`releases/latest`
  + asset API). Обычные github.com-эндпоинты (atom-фид, `/releases/latest`,
  download-ссылки) API-токены не принимают — для приватного репозитория они
  всегда 404, поэтому `addAuthHeader` с публичной схемой здесь не работает.
- **Токена нет** → сборка работает, автообновление в ней честно отключено
  (при старте пишется `[updates] токен фида не упакован`, IPC возвращает
  `supported: false` — R97i). Токен истёк/отозван → апдейтер молча пишет
  ошибку в лог, приложение работает как обычно.
- В dev-режиме обновления не проверяются (проверять не с чего — честно).
- Проверка обновления end-to-end: установить сборку версии N (с токеном),
  опубликовать релиз N+1 по инструкции выше, запустить приложение N →
  «обновление загружено», закрыть → при следующем запуске версия N+1.
- Релизный workflow GitHub Actions теперь подписывает Windows-артефакты
  Authenticode-сертификатом из секретов `WINDOWS_CERTIFICATE_BASE64` и
  `WINDOWS_CERTIFICATE_PASSWORD`, а перед публикацией проверяет статус подписи.
  Для доверия SmartScreen сертификат должен быть выдан доверенным центром
  сертификации; сам факт подписи не гарантирует мгновенное исчезновение
  предупреждения для нового издателя — репутация подписи накапливается.

### Подпись Windows-релизов

В настройках репозитория добавьте два Actions secrets:

- `WINDOWS_CERTIFICATE_BASE64` — содержимое PFX/P12, закодированное в base64;
- `WINDOWS_CERTIFICATE_PASSWORD` — пароль PFX.

PFX не хранится в Git и не включается в логи. Workflow восстанавливает его
только в `${RUNNER_TEMP}`, передаёт путь electron-builder через стандартные
`WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`, затем удаляет сертификат после сборки.
Перед публикацией `Get-AuthenticodeSignature` требует статус `Valid` у
установщика. Используйте OV/EV code-signing certificate с timestamp-подписью;
самоподписанный сертификат пригоден только для внутренних тестов и не уберёт
предупреждения SmartScreen у пользователей.

### Релиз через GitHub Actions

Для автоматической сборки без локальной Windows-машины workflow
`.github/workflows/desktop-release.yml` запускается на каждый тег вида `vX.Y.Z`:

1. версия тега должна совпадать с `desktop/package.json`;
2. workflow ставит зависимости через `npm ci` и собирает NSIS-установщик;
3. публикует `FuelRadar-Setup-<версия>.exe`, `.blockmap` и `latest.yml` в GitHub Release.

Так как репозиторий приватный, в настройках репозитория нужен secret
`UPDATE_FEED_TOKEN`: fine-grained PAT только для `Sovero/fuelradar` с правом
**Contents: Read-only**. Токен используется только во время сборки, попадает
в упакованный установщик для работы автообновлений и удаляется из workspace
после шага сборки; в логи он не выводится.

Пример публикации новой версии:

```bash
# сначала изменить desktop/package.json и закоммитить версию
# затем создать и отправить тег
git tag v0.1.2
git push origin v0.1.2
```

Если Release с таким тегом уже существует, workflow заменит его desktop-артефактами.
Для production рекомендуется не переиспользовать опубликованные теги, а создавать
новый patch/minor tag.
