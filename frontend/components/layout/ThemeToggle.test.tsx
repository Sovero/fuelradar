import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { ThemeProvider } from "@/lib/hooks/useTheme";
import { I18nProvider } from "@/lib/hooks/useI18n";

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("ThemeToggle (R99)", () => {
  it("переключает тему и сохраняет выбор в localStorage", async () => {
    render(
      <I18nProvider>
        <ThemeProvider>
          <ThemeToggle />
        </ThemeProvider>
      </I18nProvider>,
    );

    await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("light"));

    const user = userEvent.setup();
    await user.click(screen.getByRole("button"));

    await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("dark"));
    expect(window.localStorage.getItem("fr_theme")).toBe("dark");
  });
});
