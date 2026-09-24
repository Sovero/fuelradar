"""Ветка 2 живой проверки: GPS молчит, IP отвечает Краснодаром → баннер-подтверждение.

Моки ставятся после перезагрузки страницы (иначе не переживают её).
Запуск: python desktop/scripts/geo-branch2.py [порт CDP]
"""

from __future__ import annotations

import io
import json
import sys
import time
import urllib.request

from websocket import create_connection

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

BRANCH2 = r"""(async () => {
  if (!window.__origFetch) window.__origFetch = window.fetch.bind(window);
  navigator.geolocation.getCurrentPosition = () => {}; // молчащее устройство
  const ok = (city) => ({ ok: true, json: async () => ({ latitude: 45.0355, longitude: 38.9753, city, success: true }) });
  window.fetch = async (url) => {
    const u = String(url);
    if (u.includes('ipwho.is')) return ok('Краснодар');
    if (u.includes('ip-api.com')) return ok('Krasnodar');
    return window.__origFetch(url);
  };
  const btn = [...document.querySelectorAll('button')].find((b) => /Найти топливо рядом/i.test(b.textContent));
  if (!btn) return { error: 'button not found' };
  btn.click();
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const t = document.body.innerText;
    const searching = /Определяем местоположение/i.test(t);
    const banner = /возможно, вы в городе/i.test(t);
    const far = /за пределами региона/i.test(t);
    const denied = /доступ (запрещ|отклон)|заблокирован/i.test(t);
    if (!searching || banner || far || denied) {
      const confirm = [...document.querySelectorAll('button')].find((b) => /Показать станции/.test(b.textContent));
      return {
        waitedSeconds: (i + 1) * 2,
        banner, far, denied,
        searchingStill: searching,
        bannerText: banner ? (t.match(/возможно, вы в городе[^\n]+/) || [null])[0] : null,
        confirmPresent: !!confirm,
        confirmLabel: confirm ? confirm.textContent.trim() : null,
      };
    }
  }
  return { stuck: true };
})()"""


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

    def ev(self, expr: str):
        r = self.call("Runtime.evaluate", {"expression": expr, "awaitPromise": True, "returnByValue": True})
        res = r.get("result", {}).get("result", {})
        if res.get("subtype") == "error":
            raise RuntimeError(res.get("description", ""))
        return res.get("value")


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9335
    data = urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=5).read().decode()
    page = next(t for t in json.loads(data) if t.get("type") == "page")
    cdp = CDP(page["webSocketDebuggerUrl"])

    cdp.ev("location.reload(); true")
    time.sleep(6)
    out = cdp.ev(BRANCH2)
    print("BRANCH2-IP-CANDIDATE:", json.dumps(out, ensure_ascii=False, indent=1))
    cdp.ws.close()


if __name__ == "__main__":
    main()
