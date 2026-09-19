import { afterEach, describe, expect, it, vi } from "vitest";

import { lookupIpPosition } from "@/lib/geoIp";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("lookupIpPosition", () => {
  it("returns coordinates and city on a successful lookup", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ success: true, latitude: 45.035, longitude: 38.975, city: "Краснодар" }), { status: 200 }),
        ),
      ),
    );

    const result = await lookupIpPosition();

    expect(result).toEqual({ lat: 45.035, lon: 38.975, place: "Краснодар" });
  });

  it("tolerates a missing city field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ success: true, latitude: 45.035, longitude: 38.975 }), { status: 200 })),
      ),
    );

    const result = await lookupIpPosition();

    expect(result.place).toBe("");
  });

  it("throws on a provider failure payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ success: false, message: "reserved range" }), { status: 200 })),
      ),
    );

    await expect(lookupIpPosition()).rejects.toThrow("reserved range");
  });

  it("throws on non-2xx HTTP answers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("too many requests", { status: 429 }))),
    );

    await expect(lookupIpPosition()).rejects.toThrow("HTTP 429");
  });
});
