"""Живая проверка геолокации в реальном desktop-приложении FuelRadar (0.1.5).

Подключается к CDP (remote-debugging-port), кликает «Найти топливо рядом»
и снимает состояние: permission, сообщение кнопки, баннер города по IP,
состояние карты. Только чтение и один пользовательский клик.

Запуск: python desktop/scripts/geo-live-check.py [порт CDP, по умолчанию 9335]
Приложение должно быть запущено с --remote-debugging-port=<порт> --remote-allow-origins=*
"""

from __future__ import annotations

import io
import json
import sys
import time
import urllib.request

from websocket import create_connection

# Windows-консоль: emoji/стрелки в выводе не должны ронять скрипт
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")


def find_page_ws(port: int) -> str:
    data = urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=5).read().decode()
    targets = json.loads(data)
    page = next((t for t in targets if t.get("type") == "page"), None)
    if page is None:
        raise SystemExit("нет открытой страницы в приложении")
    return page["webSocketDebuggerUrl"]


class CDP:
    def __init__(self, url: str) -> None:
        self.ws = create_connection(url, timeout=60)
        self._id = 0

    def call(self, method: str, params: dict | None = None) -> dict:
        self._id += 1
        self.ws.send(json.dumps({"id": self._id, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self._id:
                return msg

    def eval(self, expr: str):
        r = self.call("Runtime.evaluate", {"expression": expr, "awaitPromise": True, "returnByValue": True})
        result = r.get("result", {}).get("result", {})
        if result.get("subtype") == "error":
            raise RuntimeError(result.get("description", "evaluate error"))
        return result.get("value")


FIND_NEARBY_SELECTOR_HINTS = [
    "[data-test='find-nearby']",
    "[aria-label*='рядом']",
    "button[title*='рядом']",
]


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9335
    ws = CDP(find_page_ws(port))

    print("=== 1. Состояние окружения геолокации ===")
    state = ws.eval(
        """(async () => {
        const out = {};
        out.userAgent = navigator.userAgent.slice(0, 100);
        out.hasGeolocation = !!navigator.geolocation;
        try {
          const st = await navigator.permissions.query({ name: 'geolocation' });
          out.permission = st.state;
        } catch (e) { out.permission = 'query-failed: ' + e.message; }
        out.localStorageKeys = Object.keys(localStorage).filter(k =>
          /privac|geo|pos|last/i.test(k));
        out.manualPoint = localStorage.getItem('fr_manual_point') || localStorage.getItem('fr_privacy_manual_point') || null;
        return out;
      })()"""
    )
    print(json.dumps(state, ensure_ascii=False, indent=1))

    print("\n=== 2. Кнопка «Найти топливо рядом» ===")
    btn_info = ws.eval(
        """(() => {
        const all = [...document.querySelectorAll('button')];
        const btn = all.find(b => /Найти топливо рядом|найди|рядом/i.test(b.textContent + ' ' + (b.getAttribute('aria-label') || '')));
        if (!btn) return { found: false, buttons: all.slice(0, 12).map(b => (b.getAttribute('aria-label') || b.textContent).trim().slice(0, 40)) };
        return { found: true, text: btn.textContent.trim(), ariaLabel: btn.getAttribute('aria-label'), dataTest: btn.getAttribute('data-test') };
      })()"""
    )
    print(json.dumps(btn_info, ensure_ascii=False))
    if not btn_info.get("found"):
        print("Кнопка не найдена — дальше не идём")
        return

    print("\n=== 3. Кликаю и наблюдаю (сторож 12 с + IP-резерв) ===")
    ws.eval(
        """(() => {
        const all = [...document.querySelectorAll('button')];
        const btn = all.find(b => /Найти топливо рядом|найди|рядом/i.test(b.textContent + ' ' + (b.getAttribute('aria-label') || '')));
        btn.click();
        return true;
      })()"""
    )

    timeline = []
    for i in range(8):
        time.sleep(3)
        snap = ws.eval(
            """(() => {
            const text = document.body.innerText;
            const get = (re) => { const m = text.match(re); return m ? m[0] : null; };
            return {
              searching: /Определяем|Определение/i.test(text),
              denied: /доступ (запрещ|отклон)|заблокирован|denied/i.test(text),
              unavailable: /недоступ|POSITION_UNAVAILABLE|не (удалось|смогли) определить/i.test(text),
              farFromRegion: /за пределами региона|VPN|прокси/i.test(text),
              ipBanner: /возможно, вы в городе|Показать станции/i.test(text),
              mapCenter: (window.__frMapCenter || null),
            };
          })()"""
        )
        timeline.append({"t": (i + 1) * 3, **snap})
        s = {**snap, "t": (i + 1) * 3}
        print(f"t={s['t']}s: searching={s['searching']} denied={s['denied']} "
              f"unavailable={s['unavailable']} farFromRegion={s['farFromRegion']} ipBanner={s['ipBanner']}")
        if not s["searching"] and (s["denied"] or s["unavailable"] or s["farFromRegion"] or s["ipBanner"]):
            break

    print("\n=== 4. Итоговое состояние страницы ===")
    final_text = ws.eval(
        """(() => {
        const text = document.body.innerText;
        const lines = text.split('\\n').filter(l =>
          /геолок|рядом|местополож|город|VPN|прокси|запрещ|регион|определя/i.test(l));
        return lines.slice(0, 15);
      })()"""
    )
    for line in final_text:
        print(" ·", line[:120])

    print("\nTIMELINE:", json.dumps(timeline, ensure_ascii=False))


if __name__ == "__main__":
    main()
