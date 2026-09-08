import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OnboardingTour } from "@/components/onboarding/OnboardingTour";
import { OnboardingProvider } from "@/lib/hooks/useOnboarding";
import { I18nProvider } from "@/lib/hooks/useI18n";

function renderTour() {
  return render(
    <I18nProvider>
      <OnboardingProvider>
        <div data-tour="fuel">fuel</div>
        <div data-tour="find-nearby">find</div>
        <div data-tour="tabs">tabs</div>
        <div data-tour="map">map</div>
        <OnboardingTour />
      </OnboardingProvider>
    </I18nProvider>,
  );
}

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe("OnboardingTour (R101)", () => {
  it("показывается сам при первом визите (нет отметки в localStorage)", async () => {
    renderTour();
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    expect(screen.getByText(/Шаг 1 из 4/)).toBeInTheDocument();
  });

  it("не показывается повторно, если тур уже пройден/пропущен", () => {
    window.localStorage.setItem("fr_tour_completed", "1");
    renderTour();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("«Пропустить» закрывает тур и запоминает это в localStorage", async () => {
    renderTour();
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Пропустить" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("fr_tour_completed")).toBe("1");
  });

  it("«Далее» листает шаги, последний шаг завершает тур", async () => {
    renderTour();
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    const user = userEvent.setup();
    for (let i = 0; i < 3; i++) {
      await user.click(screen.getByRole("button", { name: "Далее" }));
    }
    expect(screen.getByText(/Шаг 4 из 4/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Готово" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
