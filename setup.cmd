@echo off
REM FuelRadar — двойной клик на новой машине: разворачивает окружение и запускает серверы.
REM Просто вызывает setup.ps1 в обход политики выполнения (ничего не меняет системно и постоянно).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
pause
