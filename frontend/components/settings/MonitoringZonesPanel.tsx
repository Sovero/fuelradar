"use client";

/**
 * Зоны мониторинга (R21: CRUD город/круг/полигон) + «следить вокруг меня»
 * (R23, динамическая CIRCLE-зона — см. `useFollowMeZone`). Полигон задаётся
 * списком точек «широта,долгота» по одной на строку — минимальный, но честный
 * способ ввести произвольную геометрию без отдельного редактора рисования по
 * карте (вне бюджета этой задачи; сама зона от этого не менее рабочая).
 */

import { useState } from "react";
import { useMonitoringZones, type ZoneBody } from "@/lib/hooks/useMonitoringZones";
import { useFollowMeZone } from "@/lib/hooks/useFollowMeZone";
import { useI18n } from "@/lib/hooks/useI18n";
import { ApiError } from "@/lib/api";
import type { ZoneOut } from "@/lib/types";

type ZoneType = ZoneOut["zone_type"];

function describeZone(zone: ZoneOut): string {
  if (zone.zone_type === "CITY") return String(zone.params.city ?? "—");
  if (zone.zone_type === "CIRCLE") return `${zone.params.lat}, ${zone.params.lon} · ${zone.params.radius_km} км`;
  const points = (zone.params.points as unknown[]) ?? [];
  return `${points.length} точек`;
}

function parsePolygonInput(text: string): number[][] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(",").map((v) => Number(v.trim())));
}

export function MonitoringZonesPanel() {
  const { zones, loading, error, create, update, remove } = useMonitoringZones();
  const followMe = useFollowMeZone({ zones, create, update });
  const { t } = useI18n();

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [zoneType, setZoneType] = useState<ZoneType>("CITY");
  const [city, setCity] = useState("");
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [radiusKm, setRadiusKm] = useState("10");
  const [polygonText, setPolygonText] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function resetForm() {
    setEditingId(null);
    setName("");
    setZoneType("CITY");
    setCity("");
    setLat("");
    setLon("");
    setRadiusKm("10");
    setPolygonText("");
    setFormError(null);
    setFormOpen(false);
  }

  function startEdit(zone: ZoneOut) {
    setEditingId(zone.id);
    setName(zone.name);
    setZoneType(zone.zone_type);
    setCity(String(zone.params.city ?? ""));
    setLat(zone.params.lat !== undefined ? String(zone.params.lat) : "");
    setLon(zone.params.lon !== undefined ? String(zone.params.lon) : "");
    setRadiusKm(zone.params.radius_km !== undefined ? String(zone.params.radius_km) : "10");
    const points = (zone.params.points as number[][]) ?? [];
    setPolygonText(points.map((p) => p.join(",")).join("\n"));
    setFormOpen(true);
  }

  function buildBody(): ZoneBody | null {
    if (zoneType === "CITY") {
      if (!city.trim()) {
        setFormError(t("zones.form.cityRequired"));
        return null;
      }
      return { name: name || city, zone_type: "CITY", params: { city: city.trim() } };
    }
    if (zoneType === "CIRCLE") {
      const latN = Number(lat);
      const lonN = Number(lon);
      const radiusN = Number(radiusKm);
      if (!Number.isFinite(latN) || !Number.isFinite(lonN) || !Number.isFinite(radiusN) || radiusN <= 0) {
        setFormError(t("zones.form.circleInvalid"));
        return null;
      }
      return { name: name || t("zones.form.circleDefaultName"), zone_type: "CIRCLE", params: { lat: latN, lon: lonN, radius_km: radiusN } };
    }
    const points = parsePolygonInput(polygonText);
    if (points.length < 3 || points.some((p) => p.length !== 2 || p.some((v) => !Number.isFinite(v)))) {
      setFormError(t("zones.form.polygonInvalid"));
      return null;
    }
    return { name: name || t("zones.form.polygonDefaultName"), zone_type: "POLYGON", params: { points } };
  }

  async function handleSubmit() {
    setFormError(null);
    const body = buildBody();
    if (!body) return;
    setBusy(true);
    try {
      if (editingId !== null) await update(editingId, body);
      else await create(body);
      resetForm();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : t("zones.form.saveError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
        <div className="flex items-center justify-between">
          <div>
            <p className="font-medium text-gray-800 dark:text-gray-200">{t("zones.followMe.title")}</p>
            <p className="text-sm text-gray-500 dark:text-gray-400">{t("zones.followMe.description")}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={followMe.enabled}
            aria-label={t("zones.followMe.title")}
            onClick={() => (followMe.enabled ? followMe.disable() : followMe.enable())}
            className={`h-6 w-11 shrink-0 rounded-full transition-colors ${followMe.enabled ? "bg-emerald-600" : "bg-gray-300 dark:bg-gray-700"}`}
          >
            <span className={`block h-5 w-5 translate-y-0.5 rounded-full bg-white transition-transform ${followMe.enabled ? "translate-x-5" : "translate-x-0.5"}`} />
          </button>
        </div>
        {followMe.enabled && (
          <label className="mt-2 flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
            {t("zones.followMe.radius")}
            <input
              type="number"
              min={1}
              max={200}
              value={followMe.radiusKm}
              onChange={(e) => followMe.setRadiusKm(Number(e.target.value) || 10)}
              className="w-20 rounded-md border border-gray-300 px-2 py-1 dark:border-gray-700 dark:bg-gray-800"
            />
            км
          </label>
        )}
        {followMe.error && <p className="mt-1 text-sm text-red-600 dark:text-red-400">{followMe.error}</p>}
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="font-medium text-gray-800 dark:text-gray-200">{t("zones.list.title")}</h3>
          <button
            type="button"
            onClick={() => (formOpen ? resetForm() : setFormOpen(true))}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
          >
            {formOpen ? t("zones.form.cancel") : t("zones.form.add")}
          </button>
        </div>

        {loading && <p className="text-sm text-gray-400">{t("loading")}</p>}
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        {!loading && zones.length === 0 && !formOpen && <p className="text-sm text-gray-400">{t("zones.list.empty")}</p>}

        <ul className="flex flex-col gap-2">
          {zones.map((zone) => (
            <li key={zone.id} className="flex items-center justify-between rounded-md border border-gray-200 px-3 py-2 text-sm dark:border-gray-800">
              <div>
                <p className="font-medium text-gray-800 dark:text-gray-200">
                  {zone.name} <span className="text-xs text-gray-400">({zone.zone_type})</span>
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">{describeZone(zone)}</p>
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => startEdit(zone)} className="text-blue-700 hover:underline dark:text-blue-400">
                  {t("zones.form.edit")}
                </button>
                <button type="button" onClick={() => remove(zone.id)} className="text-red-700 hover:underline dark:text-red-400">
                  {t("zones.form.delete")}
                </button>
              </div>
            </li>
          ))}
        </ul>

        {formOpen && (
          <div className="mt-3 flex flex-col gap-2 rounded-md border border-gray-200 p-3 dark:border-gray-800">
            <input
              type="text"
              placeholder={t("zones.form.name")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800"
            />
            <select
              value={zoneType}
              onChange={(e) => setZoneType(e.target.value as ZoneType)}
              className="rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800"
            >
              <option value="CITY">{t("zones.form.type.city")}</option>
              <option value="CIRCLE">{t("zones.form.type.circle")}</option>
              <option value="POLYGON">{t("zones.form.type.polygon")}</option>
            </select>

            {zoneType === "CITY" && (
              <input
                type="text"
                placeholder={t("zones.form.cityPlaceholder")}
                value={city}
                onChange={(e) => setCity(e.target.value)}
                className="rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800"
              />
            )}

            {zoneType === "CIRCLE" && (
              <div className="flex flex-wrap gap-2">
                <input type="number" step="any" placeholder="lat" value={lat} onChange={(e) => setLat(e.target.value)} className="w-28 rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800" />
                <input type="number" step="any" placeholder="lon" value={lon} onChange={(e) => setLon(e.target.value)} className="w-28 rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800" />
                <input type="number" min={0.1} step="any" placeholder="км" value={radiusKm} onChange={(e) => setRadiusKm(e.target.value)} className="w-24 rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800" />
              </div>
            )}

            {zoneType === "POLYGON" && (
              <textarea
                placeholder={t("zones.form.polygonPlaceholder")}
                value={polygonText}
                onChange={(e) => setPolygonText(e.target.value)}
                rows={4}
                className="rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800"
              />
            )}

            {formError && <p className="text-sm text-red-600 dark:text-red-400">{formError}</p>}
            <button
              type="button"
              onClick={handleSubmit}
              disabled={busy}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? t("login.submitting") : editingId !== null ? t("zones.form.save") : t("zones.form.create")}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
