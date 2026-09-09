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

    expect(screen.getByText(/коридор по выбранным точкам/i)).toBeInTheDocument();
    expect(screen.getByText(/3 точки/i)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Удалить точку 2/i }));
    expect(onRemovePoint).toHaveBeenCalledWith(1);

    await user.clear(screen.getByRole("spinbutton", { name: /Ширина коридора/i }));
    await user.type(screen.getByRole("spinbutton", { name: /Ширина коридора/i }), "12");
    expect(onCorridorChange).toHaveBeenLastCalledWith(12);

    await user.click(screen.getByRole("button", { name: /Удалить все точки/i }));
    expect(onClear).toHaveBeenCalledOnce();
  });
});
