.PHONY: install dev test lint e2e compose-up compose-prod

# Локальная разработка (R96i): SQLite + haversine, без Docker.

install:
	pip install -r backend/requirements.txt
	cd frontend && npm install

# DEBUG включает dev-вход без пароля; CORS_ORIGINS нужен, только пока
# backend (:8000) и frontend (:3000) — разные origin для браузера (proxy
# Next.js форвардит их Origin как есть). В проде оба идут за одним Caddy —
# один origin, переменная не нужна (R66/R95i).
dev:
	cd backend && DEBUG=true CORS_ORIGINS=http://localhost:3000 uvicorn app.main:app --reload --port 8000

test:
	cd backend && pytest
	cd frontend && npm run typecheck

lint:
	cd backend && ruff check .

# Браузерные E2E критических сценариев (T15, Playwright/Chromium)
e2e:
	cd frontend && npm run test:e2e

# Наполнение каталога из источников (A01); пример: make seed ARGS="--region krasnodar --offline"
seed:
	cd backend && python -m cli.seed $(ARGS)

# Десктоп-приложение (Electron + NSIS-установщик): desktop/README.md
desktop-dist:
	cd desktop && npm install && npm run dist

# Smoke-проверка оболочки (нужен backend на :8000)
desktop-smoke:
	cd desktop && npm run smoke

# Docker (R85)
compose-up:
	docker compose up --build

compose-prod:
	docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build