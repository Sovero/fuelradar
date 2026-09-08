import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LocaleToggle } from "@/components/layout/LocaleToggle";
import { I18nProvider } from "@/lib/hooks/useI18n";

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe("LocaleToggle (R100)", () => {
  it("переключает язык ru/en и сохраняет выбор на устройстве, по умолчанию — русский", async () => {
    render(
      <I18nProvider>
        <LocaleToggle />
      </I18nProvider>,
    );

    expect(screen.getByRole("button")).toHaveTextContent("EN");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button"));

    await waitFor(() => expect(window.localStorage.getItem("fr_locale")).toBe("en"));
    expect(screen.getByRole("button")).toHaveTextContent("RU");
  });
});
