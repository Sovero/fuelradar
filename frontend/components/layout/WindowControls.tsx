"use client";

import { useEffect, useState } from "react";
import { desktopWindowControls } from "@/lib/desktop";
import { useI18n } from "@/lib/hooks/useI18n";

/**
 * Кнопки окна для безрамочного режима desktop-оболочки (frame:false).
 *
 * Рендерятся только когда мост windowControls реально есть (desktop-сборка
 * с этим ходом); в браузере и в сборках оболочки старше безрамочного режима
 * компонент не рисует ничего — там системная рамка на месте (R97i).
 */
export function WindowControls() {
  const { t } = useI18n();
  const [controls, setControls] = useState<NonNullable<ReturnType<typeof desktopWindowControls>> | null>(null);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const found = desktopWindowControls();
    if (!found) return;
    setControls(found);
    let alive = true;
    found
      .state()
      .then((state) => {
        if (alive) setMaximized(state.isMaximized);
      })
      .catch(() => {
        /* состояние окна не критично: кнопки работают и без него */
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!controls) return null;

  return (
    <div className="app-no-drag flex items-center" role="group" aria-label={t("window.controls")}>
      <button
        type="button"
        onClick={() => controls.minimize()}
        aria-label={t("window.minimize")}
        title={t("window.minimize")}
        className="flex h-8 w-10 items-center justify-center rounded text-base text-gray-500 hover:bg-black/5 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-white/10 dark:hover:text-gray-100"
      >
        ─
      </button>
      <button
        type="button"
        onClick={() => {
          controls.toggleMaximize();
          controls
            .state()
            .then((state) => setMaximized(state.isMaximized))
            .catch(() => {
              /* состояние не критично */
            });
        }}
        aria-label={maximized ? t("window.restore") : t("window.maximize")}
        title={maximized ? t("window.restore") : t("window.maximize")}
        className="flex h-8 w-10 items-center justify-center rounded text-sm text-gray-500 hover:bg-black/5 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-white/10 dark:hover:text-gray-100"
      >
        {maximized ? "❐" : "□"}
      </button>
      <button
        type="button"
        onClick={() => controls.close()}
        aria-label={t("window.close")}
        title={t("window.close")}
        className="flex h-8 w-10 items-center justify-center rounded text-sm text-gray-500 hover:bg-red-500 hover:text-white dark:text-gray-400"
      >
        ✕
      </button>
    </div>
  );
}
