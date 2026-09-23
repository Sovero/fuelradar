"use client";

/**
 * Правила уведомлений (R26/R34/R77) — CRUD поверх `/alerts`. Скоуп — то, что
 * понимает backend (`backend/app/alerts/service.py::_scope_matches`): весь
 * регион / зона / избранное / конкретная станция / радиус вокруг точки /
 * сеть (`brand_id`, с доводки после слепой приёмки — `/meta` теперь отдаёт id).
 */

import { useState } from "react";
import { useAlertRules } from "@/lib/hooks/useAlertRules";
import { useMonitoringZones } from "@/lib/hooks/useMonitoringZones";
import { useMeta } from "@/lib/hooks/useMeta";
import { useGeolocation } from "@/lib/hooks/useGeolocation";
import { useI18n } from "@/lib/hooks/useI18n";
import { formatUpdatedAt } from "@/lib/format";
import { ApiError } from "@/lib/api";
import type { AlertRuleBody } from "@/lib/types";

type ScopeKind = "all" | "zone" | "favorites" | "point" | "network";

export function AlertRulesPanel() {
  const { rules, loading, error, create, update, remove } = useAlertRules();
  const { zones } = useMonitoringZones();
  const { meta, fuelLabel, statusLabel, queueLabel } = useMeta();
  const { t } = useI18n();
  const geo = useGeolocation(t);

  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [fuelCode, setFuelCode] = useState("");
  const [distanceKm, setDistanceKm] = useState("10");
  const [statusFilter, setStatusFilter] = useState("");
  const [confidenceMin, setConfidenceMin] = useState("");
  const [queueMax, setQueueMax] = useState("");
  const [scopeKind, setScopeKind] = useState<ScopeKind>("all");
  const [zoneId, setZoneId] = useState<number | null>(null);
  const [brandId, setBrandId] = useState<number | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function buildScope(): Record<string, unknown> {
    if (scopeKind === "favorites") return { type: "favorites" };
    if (scopeKind === "zone" && zoneId !== null) return { type: "zone", zone_id: zoneId };
    if (scopeKind === "network" && brandId !== null) return { type: "network", brand_id: brandId };
    if (scopeKind === "point" && geo.position) return { lat: geo.position.lat, lon: geo.position.lon };
    return {};
  }

  function resetForm() {
    setName("");
    setFuelCode("");
    setDistanceKm("10");
    setStatusFilter("");
    setConfidenceMin("");
    setQueueMax("");
    setScopeKind("all");
    setZoneId(null);
    setBrandId(null);
    setFormError(null);
    setFormOpen(false);
  }

  async function handleSubmit() {
    setFormError(null);
    if (scopeKind === "point" && !geo.position) {
      setFormError(t("rules.form.needPosition"));
      return;
    }
    if (scopeKind === "zone" && zoneId === null) {
      setFormError(t("rules.form.needZone"));
      return;
    }
    if (scopeKind === "network" && brandId === null) {
      setFormError(t("rules.form.needNetwork"));
      return;
    }
    const body: AlertRuleBody = {
      name: name || t("rules.form.defaultName"),
      fuel_code: fuelCode || null,
      distance_km: distanceKm ? Number(distanceKm) : null,
      status_filter: statusFilter || null,
      confidence_min: confidenceMin ? Number(confidenceMin) : null,
      queue_max: queueMax || null,
      scope: buildScope(),
      is_active: true,
    };
    setBusy(true);
    try {
      await create(body);
      resetForm();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : t("rules.form.saveError"));
    } finally {
      setBusy(false);
    }
  }

  function describeScope(scope: Record<string, unknown>): string {
    if (scope.station_id) return `${t("rules.scope.station")}: ${scope.station_id}`;
    const kind = String(scope.type ?? "");
    if (kind === "favorites" || scope.favorites) return t("rules.scope.favorites");
    if (scope.zone_id !== undefined) return `${t("rules.scope.zone")} #${scope.zone_id}`;
    const brand = scope.brand_id ?? scope.network_id;
    if (brand !== undefined) {
      const found = (meta?.station_brands ?? []).find((b) => b.id === brand);
      return `${t("rules.scope.network")}: ${found?.name ?? `#${brand}`}`;
    }
    if (scope.lat !== undefined && scope.lon !== undefined) return t("rules.scope.point");
    return t("rules.scope.all");
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-gray-800 dark:text-gray-200">{t("rules.list.title")}</h3>
        <button
          type="button"
          onClick={() => (formOpen ? resetForm() : setFormOpen(true))}
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
        >
          {formOpen ? t("zones.form.cancel") : t("rules.form.add")}
        </button>
      </div>

      {loading && <p className="text-sm text-gray-400">{t("loading")}</p>}
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {!loading && rules.length === 0 && !formOpen && <p className="text-sm text-gray-400">{t("rules.list.empty")}</p>}

      <ul className="flex flex-col gap-2">
        {rules.map((rule) => (
          <li key={rule.id} className="rounded-md border border-gray-200 px-3 py-2 text-sm dark:border-gray-800">
            <div className="flex items-center justify-between">
              <p className="font-medium text-gray-800 dark:text-gray-200">{rule.name || `#${rule.id}`}</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => update(rule.id, { ...rule, is_active: !rule.is_active })}
                  className="text-blue-700 hover:underline dark:text-blue-400"
                >
                  {rule.is_active ? t("rules.pause") : t("rules.resume")}
                </button>
                <button type="button" onClick={() => remove(rule.id)} className="text-red-700 hover:underline dark:text-red-400">
                  {t("zones.form.delete")}
                </button>
              </div>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {describeScope(rule.scope)}
              {rule.fuel_code ? ` · ${fuelLabel(rule.fuel_code)}` : ""}
              {rule.status_filter ? ` · ${statusLabel(rule.status_filter)}` : ""}
              {rule.queue_max ? ` · ${t("filters.queueMax")}: ${queueLabel(rule.queue_max)}` : ""}
              {!rule.is_active ? ` · ${t("rules.paused")}` : ""}
            </p>
            <p className="text-xs text-gray-400 dark:text-gray-500">
              {t("rules.triggerCount")}: {rule.trigger_count ?? 0}
              {rule.last_event_at ? ` · ${t("rules.lastEvent")}: ${formatUpdatedAt(rule.last_event_at)}` : ` · ${t("rules.neverTriggered")}`}
            </p>
          </li>
        ))}
      </ul>

      {formOpen && (
        <div className="flex flex-col gap-2 rounded-md border border-gray-200 p-3 dark:border-gray-800">
          <input
            type="text"
            placeholder={t("zones.form.name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800"
          />

          <label className="text-xs font-semibold uppercase text-gray-500">{t("rules.form.scope")}</label>
          <select value={scopeKind} onChange={(e) => setScopeKind(e.target.value as ScopeKind)} className="rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800">
            <option value="all">{t("rules.scope.all")}</option>
            <option value="favorites">{t("rules.scope.favorites")}</option>
            <option value="zone">{t("rules.scope.zone")}</option>
            <option value="network">{t("rules.scope.network")}</option>
            <option value="point">{t("rules.scope.point")}</option>
          </select>

          {scopeKind === "network" && (
            <select value={brandId ?? ""} onChange={(e) => setBrandId(e.target.value ? Number(e.target.value) : null)} className="rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800">
              <option value="">{t("rules.form.pickNetwork")}</option>
              {(meta?.station_brands ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}

          {scopeKind === "zone" && (
            <select value={zoneId ?? ""} onChange={(e) => setZoneId(e.target.value ? Number(e.target.value) : null)} className="rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800">
              <option value="">{t("rules.form.pickZone")}</option>
              {zones.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
            </select>
          )}

          {scopeKind === "point" && (
            <div className="flex items-center gap-2 text-sm">
              <button type="button" onClick={geo.request} className="rounded-md border border-gray-300 px-2 py-1 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800">
                {t("rules.form.useCurrentPosition")}
              </button>
              {geo.position && <span className="text-emerald-700 dark:text-emerald-400">{geo.position.lat.toFixed(4)}, {geo.position.lon.toFixed(4)}</span>}
              {geo.error && <span className="text-red-600 dark:text-red-400">{geo.error}</span>}
            </div>
          )}

          <select value={fuelCode} onChange={(e) => setFuelCode(e.target.value)} className="rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800">
            <option value="">{t("rules.form.anyFuel")}</option>
            {(meta?.fuel_types ?? []).map((f) => (
              <option key={f.code} value={f.code}>
                {fuelLabel(f.code)}
              </option>
            ))}
          </select>

          <input
            type="number"
            min={0.1}
            step="any"
            placeholder={t("filters.radius")}
            value={distanceKm}
            onChange={(e) => setDistanceKm(e.target.value)}
            className="rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800"
          />

          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800">
            <option value="">{t("filters.status.any")}</option>
            {(meta?.fuel_statuses ?? []).map((s) => (
              <option key={s.code} value={s.code}>
                {statusLabel(s.code)}
              </option>
            ))}
          </select>

          <input
            type="number"
            min={0}
            max={100}
            placeholder={t("filters.confidenceMin")}
            value={confidenceMin}
            onChange={(e) => setConfidenceMin(e.target.value)}
            className="rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800"
          />

          <select value={queueMax} onChange={(e) => setQueueMax(e.target.value)} className="rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800">
            <option value="">{t("filters.queueMax.any")}</option>
            {(meta?.queue_levels ?? []).filter((q) => q.code !== "UNKNOWN").map((q) => (
              <option key={q.code} value={q.code}>
                {queueLabel(q.code)}
              </option>
            ))}
          </select>

          {formError && <p className="text-sm text-red-600 dark:text-red-400">{formError}</p>}
          <button
            type="button"
            onClick={handleSubmit}
            disabled={busy}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? t("common.saving") : t("rules.form.create")}
          </button>
        </div>
      )}
    </div>
  );
}
