"""Ветка 2, шаг подтверждения: клик «Показать станции Краснодар» применяет город.

Запуск: python desktop/scripts/geo-branch2-confirm.py [порт CDP]
"""

from __future__ import annotations

import io
import json
import sys
import time
import urllib.request

from websocket import create_connection

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

CONFIRM = r"""(async () => {
  const confirm = [...document.querySelectorAll('button')].find((b) => /Показать станции/.test(b.textContent));
  if (!confirm) return { error: 'banner gone' };
  confirm.click();
  await new Promise((r) => setTimeout(r, 2500));
  const t = document.body.innerText;
  return {
    bannerGone: !/возможно, вы в городе/.test(t),
    krasnodarListed: /Краснодар/i.test(t),
    nearMode: /рядом/i.test(t),
  };
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
    out = cdp.ev(CONFIRM)
    print("CONFIRM-APPLY:", json.dumps(out, ensure_ascii=False, indent=1))
    cdp.ws.close()


if __name__ == "__main__":
    main()
