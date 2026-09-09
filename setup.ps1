<#
.SYNOPSIS
    FuelRadar — разворачивает и запускает проект на новой машине одной командой.

.DESCRIPTION
    Идемпотентный скрипт: безопасно запускать повторно, в том числе для "обновления"
    уже развёрнутого окружения (git pull + переустановка зависимостей).

    Делает, по порядку:
      1. Проверяет наличие git/python/node/npm.
      2. git pull (если это git-репозиторий и есть remote) — подтягивает обновления.
      3. Создаёт backend\.venv (если его ещё нет) и ставит зависимости из requirements.txt.
      4. Создаёт .env из .env.example при первом запуске — с автосгенерированным
         локальным ADMIN_TOKEN (не секрет внешнего сервиса, только для этой машины)
         и DEBUG=true/CORS_ORIGINS для локальной разработки. Уже существующий .env
         НЕ трогает — ваши правки (или вписанные ключи) не будут потеряны.
      5. npm install во frontend/, создаёт frontend\.env.local из примера при первом запуске.
      6. Наполняет каталог демо-данными из офлайн-фикстур (без сети), если БД пустая.
      7. Запускает backend (uvicorn) в отдельном окне и frontend (npm run dev) в текущем.

.PARAMETER SkipPull
    Не выполнять git pull (например, если правите код локально и не хотите его затирать).

.PARAMETER SkipSeed
    Не наполнять каталог демо-данными.

.PARAMETER SkipStart
    Только развернуть окружение (venv, зависимости, .env), серверы не запускать.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\setup.ps1
    Полный цикл: обновить, развернуть, наполнить демо-данными, запустить.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\setup.ps1 -SkipPull -SkipStart
    Только обновить зависимости в уже склонированном репозитории, без запуска серверов.
#>

[CmdletBinding()]
param(
    [switch]$SkipPull,
    [switch]$SkipSeed,
    [switch]$SkipStart
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$BackendDir = Join-Path $Root "backend"
$FrontendDir = Join-Path $Root "frontend"
$VenvDir = Join-Path $BackendDir ".venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$VenvPip = Join-Path $VenvDir "Scripts\pip.exe"

function Write-Step($text) {
    Write-Host ""
    Write-Host "== $text ==" -ForegroundColor Cyan
}

function Test-CommandExists($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function New-RandomToken([int]$Length = 48) {
    $chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    -join (1..$Length | ForEach-Object { $chars[(Get-Random -Maximum $chars.Length)] })
}

# ---------- 1. Проверка предпосылок ----------

Write-Step "Проверка окружения"

$missing = @()
foreach ($cmd in @("git", "python", "node", "npm")) {
    if (Test-CommandExists $cmd) {
        $version = & $cmd --version 2>&1 | Select-Object -First 1
        Write-Host "  [OK] $cmd -> $version"
    } else {
        $missing += $cmd
    }
}
if ($missing.Count -gt 0) {
    Write-Host ""
    Write-Host "Не найдено: $($missing -join ', ')" -ForegroundColor Red
    Write-Host "Установите недостающее и запустите скрипт заново:"
    Write-Host "  - git:    https://git-scm.com/downloads"
    Write-Host "  - python: https://www.python.org/downloads/ (при установке отметьте 'Add to PATH')"
    Write-Host "  - node:   https://nodejs.org/ (LTS-версия, npm ставится вместе с ним)"
    exit 1
}

# ---------- 2. git pull ----------

if (-not $SkipPull) {
    Write-Step "Обновление кода (git pull)"
    if (Test-Path (Join-Path $Root ".git")) {
        Push-Location $Root
        try {
            $hasRemote = (git remote) -contains "origin"
            if ($hasRemote) {
                git pull --ff-only
            } else {
                Write-Host "  Remote 'origin' не настроен — пропускаю pull." -ForegroundColor Yellow
            }
        } catch {
            Write-Host "  git pull не удался (нет сети или есть локальные конфликты) — продолжаю с тем, что есть." -ForegroundColor Yellow
            Write-Host "  $($_.Exception.Message)" -ForegroundColor Yellow
        } finally {
            Pop-Location
        }
    } else {
        Write-Host "  Это не git-репозиторий — пропускаю pull." -ForegroundColor Yellow
    }
} else {
    Write-Host "-> git pull пропущен (-SkipPull)"
}

# ---------- 3. Backend: venv + зависимости ----------

Write-Step "Backend: виртуальное окружение и зависимости"

if (-not (Test-Path $VenvPython)) {
    Write-Host "  Создаю venv: $VenvDir"
    python -m venv $VenvDir
} else {
    Write-Host "  venv уже есть: $VenvDir"
}

& $VenvPython -m pip install --upgrade pip --quiet
& $VenvPip install -r (Join-Path $BackendDir "requirements.txt")

# ---------- 4. .env ----------

Write-Step "Настройка .env"

$EnvFile = Join-Path $Root ".env"
$EnvExample = Join-Path $Root ".env.example"

if (-not (Test-Path $EnvFile)) {
    Write-Host "  .env не найден — создаю из .env.example с локальными настройками для разработки."
    Copy-Item $EnvExample $EnvFile

    $content = Get-Content $EnvFile -Raw -Encoding UTF8
    $content = $content -replace '(?m)^DEBUG=false\s*$', 'DEBUG=true'
    $content = $content -replace '(?m)^ADMIN_TOKEN=\s*$', "ADMIN_TOKEN=$(New-RandomToken)"
    if ($content -notmatch '(?m)^CORS_ORIGINS=') {
        $content += "`n# Добавлено setup.ps1: backend (:8000) и frontend (:3000) — разные origin для браузера в dev`nCORS_ORIGINS=http://localhost:3000`n"
    }
    Set-Content -Path $EnvFile -Value $content -Encoding UTF8 -NoNewline

    Write-Host "  Готово. ADMIN_TOKEN сгенерирован автоматически — это локальный секрет только для этой" -ForegroundColor Green
    Write-Host "  машины (не внешний сервис), посмотреть его можно в .env." -ForegroundColor Green
    Write-Host "  Внешние интеграции (Telegram, Web Push, SMTP, Яндекс.Карты) — по-прежнему пустые" -ForegroundColor Green
    Write-Host "  placeholder'ы в .env: впишите свои ключи вручную, если они нужны." -ForegroundColor Green
} else {
    Write-Host "  .env уже существует — оставляю как есть (ваши настройки не тронуты)."
}

# ---------- 5. Frontend: npm install + .env.local ----------

Write-Step "Frontend: зависимости"

Push-Location $FrontendDir
try {
    npm install
} finally {
    Pop-Location
}

$FrontendEnvLocal = Join-Path $FrontendDir ".env.local"
$FrontendEnvExample = Join-Path $FrontendDir ".env.example"
if (-not (Test-Path $FrontendEnvLocal) -and (Test-Path $FrontendEnvExample)) {
    Write-Host "  frontend\.env.local не найден — создаю из примера."
    Copy-Item $FrontendEnvExample $FrontendEnvLocal
} else {
    Write-Host "  frontend\.env.local уже существует или пример отсутствует — пропускаю."
}

# ---------- 6. Демо-данные ----------

if (-not $SkipSeed) {
    Write-Step "Наполнение каталога демо-данными (офлайн, без сети)"
    Push-Location $BackendDir
    try {
        & $VenvPython -m cli.seed --region krasnodar --offline
    } catch {
        Write-Host "  Сидирование не удалось — не критично, можно запустить вручную позже:" -ForegroundColor Yellow
        Write-Host "  cd backend; .venv\Scripts\python.exe -m cli.seed --region krasnodar --offline" -ForegroundColor Yellow
    } finally {
        Pop-Location
    }
} else {
    Write-Host "-> Сидирование демо-данных пропущено (-SkipSeed)"
}

# ---------- 7. Запуск серверов ----------

if ($SkipStart) {
    Write-Host ""
    Write-Host "Окружение готово. Запуск серверов пропущен (-SkipStart)." -ForegroundColor Green
    Write-Host "Запустить вручную:"
    Write-Host "  backend:  cd backend; ..\.venv\Scripts\Activate.ps1; uvicorn app.main:app --reload --port 8000"
    Write-Host "  frontend: cd frontend; npm run dev"
    exit 0
}

Write-Step "Запуск серверов"

# .env уже содержит DEBUG/CORS_ORIGINS/ADMIN_TOKEN для локальной разработки (см. шаг 4),
# uvicorn подхватит их сам через pydantic-settings — читать .env вручную не нужно.
$BackendCmd = "cd '$BackendDir'; & '$VenvPython' -m uvicorn app.main:app --reload --port 8000"
Write-Host "  Backend  -> новое окно PowerShell, http://localhost:8000"
Start-Process powershell -ArgumentList "-NoExit", "-Command", $BackendCmd

Start-Sleep -Seconds 2

Write-Host "  Frontend -> это окно, http://localhost:3000 (Ctrl+C — остановить)"
Write-Host ""
Push-Location $FrontendDir
try {
    npm run dev
} finally {
    Pop-Location
}
