"""Ветка «реальная сеть» (NYC через VPN): перезагрузка, клик, ожидание исхода.

Запуск: python desktop/scripts/geo-branch-real.py [порт CDP]
"""

from __future__ import annotations

import io
import json
import sys
import time
import urllib.request

from websocket import create_connection

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")


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


CLICK_AND_WAIT = r"""(async () => {
  const btn = [...document.querySelectorAll('button')].find((b) => /Найти топливо рядом/i.test(b.textContent));
  if (!btn) return { error: 'button not found' };
  btn.click();
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const t = document.body.innerText;
    const searching = /Определяем местоположение/i.test(t);
    const far = /за пределами региона/i.test(t);
    const banner = /возможно, вы в городе/.test(t);
    const denied = /доступ (запрещ|отклон)|заблокирован/i.test(t);
    if (!searching || far || banner || denied) {
      return {
        waitedSeconds: (i + 1) * 2,
        searchingStopped: !searching,
        far, banner, denied,
        msg: (t.match(/Сеть определяет[^\n]*|возможно, вы в городе[^\n]*/) || [null])[0],
      };
    }
  }
  return { stuck: true, searchingStill: true };
})()"""


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9335
    data = urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=5).read().decode()
    page = next(t for t in json.loads(data) if t.get("type") == "page")
    cdp = CDP(page["webSocketDebuggerUrl"])

    cdp.ev("location.reload(); true")
    time.sleep(6)
    out = cdp.ev(CLICK_AND_WAIT)
    print("REAL-NETWORK-BRANCH:", json.dumps(out, ensure_ascii=False, indent=1))
    cdp.ws.close()


if __name__ == "__main__":
    main()
