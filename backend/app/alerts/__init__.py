"""Уведомления (T07, §13): события из diff состояния, правила, каналы доставки.

CRUD правил (`/alerts`) — уже в `backend/app/api/personal.py` (T05); этот пакет
отвечает за оценку правил (`evaluate_rules`, вызывается из `confidence.service`
после пересчёта `station_current_status`) и за ленту/счётчик уведомлений
(`GET/POST /notifications*`, A03).
"""
