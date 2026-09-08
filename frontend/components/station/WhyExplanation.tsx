"use client";

import { useState } from "react";
import type { StatusExplanation } from "@/lib/types";

/**
 * «Почему система так считает» (R71/R92) — источники прямо из ответа
 * `/stations/{id}` (status_explanation), без придуманного текста.
 * Для «нет данных» — тоже есть объяснение (R71.1).
 */
export function WhyExplanation({ explanation }: { explanation: StatusExplanation }) {
  const [open, setOpen] = useState(false);
  const contributions = explanation.contributions ?? [];

  return (
    <div className="border-t border-gray-100 pt-3 dark:border-gray-800">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="text-sm font-medium text-blue-700 hover:underline dark:text-blue-400"
      >
        Почему система так считает?
      </button>
      {open && (
        <div className="mt-2 rounded-md bg-blue-50 p-3 text-sm text-gray-700 dark:bg-blue-950/40 dark:text-gray-300">
          {contributions.length === 0 ? (
            <p>{explanation.reason || "По выбранному топливу наблюдений нет, или они устарели (старше срока действия данных)."}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {contributions.map((c, i) => (
                <li key={i}>{typeof c.label === "string" ? c.label : `${c.source ?? "Источник"} — ${c.age_minutes ?? "?"} минут назад`}</li>
              ))}
            </ul>
          )}
          {explanation.note && <p className="mt-2 text-xs text-gray-500 dark:text-gray-500">{explanation.note}</p>}
        </div>
      )}
    </div>
  );
}
