import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EmptyState } from "@/components/ui/EmptyState";
import { I18nProvider } from "@/lib/hooks/useI18n";

describe("EmptyState", () => {
  it("показывает текст брифа §108 и все 4 действия (R75)", async () => {
    const onExpandRadius = vi.fn();
    const onShowLikely = vi.fn();
    const onCreateAlert = vi.fn();
    render(
      <I18nProvider>
        <EmptyState
          radiusKm={10}
          fuelLabel="АИ-95"
          onExpandRadius={onExpandRadius}
          onShowLikely={onShowLikely}
          onCreateAlert={onCreateAlert}
          likelyShown={false}
        />
      </I18nProvider>,
    );

    expect(screen.getByText(/В радиусе 10 км подтверждённого АИ-95 не найдено/)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "+20 км" }));
    expect(onExpandRadius).toHaveBeenCalledWith(20);

    await user.click(screen.getByRole("button", { name: "+30 км" }));
    expect(onExpandRadius).toHaveBeenCalledWith(30);

    await user.click(screen.getByRole("button", { name: "Показывать вероятное наличие" }));
    expect(onShowLikely).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: /Создать уведомление/ }));
    expect(onCreateAlert).toHaveBeenCalledOnce();
  });
});
