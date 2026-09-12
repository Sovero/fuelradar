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
- Фид — `publish` в `desktop/package.json` (`provider: generic`,
  `url: https://updates.fuelradar.example/desktop/` — **замените на реальный**).
  На сервер достаточно выложить `FuelRadar-Setup-<v>.exe`, `latest.yml`
  и `.blockmap` — updater сам сравнит версию и sha512.
- В dev-режиме обновления не проверяются (проверять не с чего — честно).
- Подпись кода сейчас отсутствует (`signing is skipped`); SmartScreen будет
  предупреждать до подключения сертификата.
