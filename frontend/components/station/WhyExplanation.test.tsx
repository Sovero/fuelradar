import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WhyExplanation } from "@/components/station/WhyExplanation";
import { I18nProvider } from "@/lib/hooks/useI18n";

function renderExplanation(props: Parameters<typeof WhyExplanation>[0]) {
  render(
    <I18nProvider>
      <WhyExplanation {...props} />
    </I18nProvider>,
  );
}

describe("WhyExplanation", () => {
  it("показывает источники из status_explanation (R71/R92)", async () => {
    renderExplanation({
      explanation: {
        status: "AVAILABLE",
        contributions: [{ label: "Источник A — 12 минут назад" }, { label: "Источник B — 18 минут назад" }],
      },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Почему система так считает/ }));
    expect(screen.getByText("Источник A — 12 минут назад")).toBeInTheDocument();
    expect(screen.getByText("Источник B — 18 минут назад")).toBeInTheDocument();
  });

  it("для «нет данных» показывает честное объяснение, а не пустоту (R71.1)", async () => {
    renderExplanation({ explanation: { status: "UNKNOWN", contributions: [] } });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Почему система так считает/ }));
    expect(screen.getByText(/наблюдений нет, или они устарели/)).toBeInTheDocument();
  });
});
