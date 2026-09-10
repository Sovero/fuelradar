import type { ComponentType } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { MapView } from "@/components/map/MapView";
import type { MapProviderProps } from "@/lib/map/types";

const received: MapProviderProps[] = [];

vi.mock("@/lib/hooks/useMapProviderPreference", () => ({
  useMapProviderPreference: () => ({
    ProviderComponent: ((props: MapProviderProps) => {
      received.push(props);
      return (
        <button type="button" onClick={() => props.onMapClick?.({ lat: 45.1, lon: 39.1 })}>
          Тестовая карта
        </button>
      );
    }) as ComponentType<MapProviderProps>,
  }),
}));

vi.mock("@/components/map/Legend", () => ({ Legend: () => null }));

describe("MapView Route Mode contract (R22)", () => {
  it("передаёт линию и клики через общий MapProviderProps", async () => {
    const onMapClick = vi.fn();
    const routePolyline = [
      { lat: 45, lon: 39 },
      { lat: 45.2, lon: 39.2 },
    ];

    render(
      <MapView
        stations={[]}
        selectedFuelCodes={[]}
        selectedStationId={null}
        onSelectStation={vi.fn()}
        focus={null}
        routePolyline={routePolyline}
        onMapClick={onMapClick}
      />,
    );

    expect(received.at(-1)?.routePolyline).toEqual(routePolyline);
    await userEvent.click(screen.getByRole("button", { name: "Тестовая карта" }));
    expect(onMapClick).toHaveBeenCalledWith({ lat: 45.1, lon: 39.1 });
  });
});

describe("MapView heatmap contract (R50)", () => {
  it("передаёт круги heatmap через общий MapProviderProps без изменений", () => {
    const heatCircles = [
      { lat: 45.01, lon: 39.01, color: "#16a34a", stationId: "fr_a" },
      { lat: 45.02, lon: 39.02, color: "#dc2626", stationId: "fr_b" },
    ];

    render(
      <MapView
        stations={[]}
        selectedFuelCodes={[]}
        selectedStationId={null}
        onSelectStation={vi.fn()}
        focus={null}
        heatCircles={heatCircles}
      />,
    );

    expect(received.at(-1)?.heatCircles).toEqual(heatCircles);
  });

  it("без heatmap поле не передаётся — маркеры работают как раньше", () => {
    render(
      <MapView
        stations={[]}
        selectedFuelCodes={[]}
        selectedStationId={null}
        onSelectStation={vi.fn()}
        focus={null}
      />,
    );

    expect(received.at(-1)?.heatCircles).toBeUndefined();
  });
});
