import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { RouteModePanel } from "@/components/route/RouteModePanel";
import { I18nProvider } from "@/lib/hooks/useI18n";

describe("RouteModePanel (R22)", () => {
  it("включает честный коридор по точкам", async () => {
    const onActiveChange = vi.fn();
    render(
      <I18nProvider>
        <RouteModePanel
          active={false}
          points={[]}
          corridorKm={5}
          onActiveChange={onActiveChange}
          onCorridorChange={vi.fn()}
          onRemovePoint={vi.fn()}
          onClear={vi.fn()}
        />
      </I18nProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: /Коридор маршрута/i }));
    expect(onActiveChange).toHaveBeenCalledWith(true);
  });

  it("показывает точки, удаляет их и меняет ширину коридора", async () => {
    const onCorridorChange = vi.fn();
    const onRemovePoint = vi.fn();
    const onClear = vi.fn();
    render(
      <I18nProvider>
        <RouteModePanel
          active
          points={[
            { lat: 45.01, lon: 39.01 },
            { lat: 45.02, lon: 39.02 },
            { lat: 45.03, lon: 39.03 },
          ]}
          corridorKm={5}
          onActiveChange={vi.fn()}
          onCorridorChange={onCorridorChange}
          onRemovePoint={onRemovePoint}
          onClear={onClear}
        />
      </I18nProvider>,
    );

    expect(screen.getByRole("region", { name: /коридор по выбранным точкам/i })).toBeInTheDocument();
    expect(screen.getByTestId("route-point-count")).toHaveTextContent(/3 точки/i);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Удалить точку 2/i }));
    expect(onRemovePoint).toHaveBeenCalledWith(1);

    await user.clear(screen.getByRole("spinbutton", { name: /Ширина коридора/i }));
    await user.type(screen.getByRole("spinbutton", { name: /Ширина коридора/i }), "12");
    expect(onCorridorChange).toHaveBeenLastCalledWith(12);

    await user.click(screen.getByRole("button", { name: /Удалить все точки/i }));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it("показывает дорожный маршрут, км/мин роутера и маневры", async () => {
    render(
      <I18nProvider>
        <RouteModePanel
          active
          points={[
            { lat: 45.03, lon: 38.94 },
            { lat: 45.02, lon: 38.97 },
          ]}
          corridorKm={5}
          plan={{
            is_road_route: true,
            provider: "osrm",
            distance_km: 4.2,
            duration_min: 9,
            geometry: [
              { lat: 45.03, lon: 38.94 },
              { lat: 45.02, lon: 38.97 },
            ],
            steps: [
              { type: "depart", modifier: null, street: null, distance_m: 120, duration_s: 20 },
              { type: "turn", modifier: "right", street: "ул. Северная", distance_m: 300, duration_s: 60 },
              { type: "turn", modifier: "slight left", street: null, distance_m: 2100, duration_s: 200 },
            ],
            reason: null,
          }}
          onActiveChange={vi.fn()}
          onCorridorChange={vi.fn()}
          onRemovePoint={vi.fn()}
          onClear={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getByTestId("route-road-note")).toHaveAttribute("title", expect.stringMatching(/по дорогам и улицам/i));
    // Км/мин — из роутера, а не из средней скорости и прямой линии.
    expect(screen.getByTestId("route-road-note")).toHaveTextContent("4.2 км");
    expect(screen.getByTestId("route-road-note")).toHaveTextContent("9 мин");
    // Маневры — за переключателем-вкладкой (не занимают место, пока не открыты).
    await userEvent.click(screen.getByTestId("route-steps-toggle"));
    const steps = screen.getByTestId("route-steps");
    expect(steps).toHaveTextContent(/Поверните направо/);
    expect(steps).toHaveTextContent(/ул. Северная/);
    expect(steps).toHaveTextContent(/Плавно налево/);
    expect(steps).toHaveTextContent(/300 м/);
  });

  it("честно объясняет, почему линия прямая", () => {
    render(
      <I18nProvider>
        <RouteModePanel
          active
          points={[
            { lat: 45.03, lon: 38.94 },
            { lat: 45.02, lon: 38.97 },
          ]}
          corridorKm={5}
          plan={{
            is_road_route: false,
            provider: null,
            distance_km: null,
            duration_min: null,
            geometry: null,
            steps: [],
            reason: "provider_unavailable",
          }}
          onActiveChange={vi.fn()}
          onCorridorChange={vi.fn()}
          onRemovePoint={vi.fn()}
          onClear={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getByTestId("route-straight-note")).toHaveTextContent(/прямая линия/i);
    expect(screen.getByText(/Роутер недоступен/i)).toBeInTheDocument();
    expect(screen.queryByTestId("route-steps")).toBeNull();
    expect(screen.queryByTestId("route-steps-toggle")).toBeNull();
  });

  it("stepsOpenRequest открывает вкладку маневров и подсвечивает активный шаг", async () => {
    const user = userEvent.setup();
    const onStepsOpenHandled = vi.fn();
    const plan = {
      is_road_route: true,
      provider: "osrm",
      distance_km: 4.2,
      duration_min: 9,
      geometry: [
        { lat: 45.03, lon: 38.94 },
        { lat: 45.02, lon: 38.97 },
      ],
      steps: [
        { type: "depart", modifier: null, street: null, distance_m: 120, duration_s: 20 },
        { type: "turn", modifier: "right", street: "ул. Северная", distance_m: 300, duration_s: 60 },
      ],
      reason: null,
    };
    const { rerender } = render(
      <I18nProvider>
        <RouteModePanel
          active
          points={[]}
          corridorKm={5}
          plan={plan}
          onActiveChange={vi.fn()}
          onCorridorChange={vi.fn()}
          onRemovePoint={vi.fn()}
          onClear={vi.fn()}
        />
      </I18nProvider>,
    );

    // Вкладка закрыта, пока триггера не было (маневры не занимают место).
    expect(screen.queryByTestId("route-steps")).toBeNull();

    // Клик по подписи линии приходит как счётчик-триггер: вкладка открывается,
    // родителю сообщается об обработке (чтобы он сбросил счётчик), активный шаг
    // (ближайший к подписи) подсвечен и помечен data-testid для E2E.
    rerender(
      <I18nProvider>
        <RouteModePanel
          active
          points={[]}
          corridorKm={5}
          plan={plan}
          onActiveChange={vi.fn()}
          onCorridorChange={vi.fn()}
          onRemovePoint={vi.fn()}
          onClear={vi.fn()}
          stepsOpenRequest={1}
          onStepsOpenHandled={onStepsOpenHandled}
          activeStepIndex={1}
        />
      </I18nProvider>,
    );

    expect(await screen.findByTestId("route-steps")).toBeInTheDocument();
    expect(onStepsOpenHandled).toHaveBeenCalled();
    expect(screen.getByTestId("route-step-active")).toHaveTextContent(/Северная/);

    // Пользователь всё ещё может закрыть вкладку вручную.
    await user.click(screen.getByTestId("route-steps-toggle"));
    expect(screen.queryByTestId("route-steps")).toBeNull();
  });
});
