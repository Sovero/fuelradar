import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TourRestartButton } from "@/components/layout/TourRestartButton";
import { OnboardingTour } from "@/components/onboarding/OnboardingTour";
import { OnboardingProvider } from "@/lib/hooks/useOnboarding";
import { I18nProvider } from "@/lib/hooks/useI18n";

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe("TourRestartButton (R101)", () => {
  it("запускает тур заново из шапки, даже если он уже был пройден", async () => {
    window.localStorage.setItem("fr_tour_completed", "1");
    render(
      <I18nProvider>
        <OnboardingProvider>
          <TourRestartButton />
          <OnboardingTour />
        </OnboardingProvider>
      </I18nProvider>,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Показать тур ещё раз" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
  });
});
