.PHONY: install dev test lint compose-up compose-prod

# Локальная разработка (R96i): SQLite + haversine, без Docker.

install:
	pip install -r backend/requirements.txt
	cd frontend && npm install

dev:
	cd backend && uvicorn app.main:app --reload --port 8000

test:
	cd backend && pytest
	cd frontend && npm run typecheck

lint:
	cd backend && ruff check .

# Наполнение каталога из источников (A01); пример: make seed ARGS="--region krasnodar --offline"
seed:
	cd backend && python -m cli.seed $(ARGS)

# Docker (R85)
compose-up:
	docker compose up --build

compose-prod:
	docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build