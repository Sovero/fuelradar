import { afterEach, describe, expect, it, vi } from "vitest";
import { drawMarkerIcon, markerIconKey } from "@/lib/map/markerIcon";
import type { MarkerBadge } from "@/lib/map/types";

function badge(fuelCode: string, status: MarkerBadge["status"]): MarkerBadge {
  return { fuelCode, status, ok: status === "AVAILABLE" };
}

describe("station marker icon", () => {
  it("keeps the icon key tied to fuel statuses and the network ring", () => {
    const badges = [badge("AI_95", "AVAILABLE")];

    expect(markerIconKey(badges, null)).toBe("AI_95:AVAILABLE");
    expect(markerIconKey(badges, "#2563eb")).toBe("AI_95:AVAILABLE##2563eb");
    expect(markerIconKey([badge("AI_95", "UNAVAILABLE")], null)).not.toBe(markerIconKey(badges, null));
  });

  it("draws a recognisable fuel-pump silhouette instead of a generic circle", () => {
    const context = {
      arc: vi.fn(),
      beginPath: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      fillRect: vi.fn(),
      lineTo: vi.fn(),
      moveTo: vi.fn(),
      quadraticCurveTo: vi.fn(),
      restore: vi.fn(),
      save: vi.fn(),
      stroke: vi.fn(),
      clip: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: () => context,
    });

    try {
      const canvas = drawMarkerIcon(["#16a34a"], [true], "#2563eb");

      expect(canvas.width).toBe(40);
      expect(canvas.height).toBe(40);
      expect(context.quadraticCurveTo).toHaveBeenCalled(); // rounded pump body + hose
      expect(context.fillRect).toHaveBeenCalledWith(13, 14, 11, 6); // pump display
      expect(context.lineTo).toHaveBeenCalledWith(34, 17); // nozzle handle
    } finally {
      if (descriptor) Object.defineProperty(HTMLCanvasElement.prototype, "getContext", descriptor);
    }
  });
});
