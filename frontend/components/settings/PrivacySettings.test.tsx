import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PrivacySettings } from "@/components/settings/PrivacySettings";
import { PrivacyProvider } from "@/lib/hooks/usePrivacy";
import { I18nProvider } from "@/lib/hooks/useI18n";
import { markNetworkFarFromHome, resetNetworkFarFromHome } from "@/lib/geoIp";

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  window.localStorage.clear();
  resetNetworkFarFromHome();
});

function renderSettings() {
  render(
    <I18nProvider>
      <PrivacyProvider>
        <PrivacySettings />
      </PrivacyProvider>
    </I18nProvider>,
  );
}

describe("PrivacySettings (R24)", () => {
  it("выключение GPS сохраняется в localStorage", async () => {
    renderSettings();
    const toggle = screen.getByRole("switch", { name: /Использовать GPS/i });
    expect(toggle).toHaveAttribute("aria-checked", "true");

    const user = userEvent.setup();
    await user.click(toggle);

    await waitFor(() => expect(window.localStorage.getItem("fr_privacy_gps_enabled")).toBe("0"));
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("невалидные координаты ручной точки отклоняются", async () => {
    renderSettings();
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("широта"), "999");
    await user.type(screen.getByPlaceholderText("долгота"), "38");
    await user.click(screen.getByText("Сохранить"));

    expect(await screen.findByText(/Проверьте координаты/)).toBeInTheDocument();
    expect(window.localStorage.getItem("fr_privacy_manual_point")).toBeNull();
  });

  it("валидная ручная точка сохраняется и показывается", async () => {
    renderSettings();
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("широта"), "45.05");
    await user.type(screen.getByPlaceholderText("долгота"), "38.97");
    await user.click(screen.getByText("Сохранить"));

    await waitFor(() => expect(window.localStorage.getItem("fr_privacy_manual_point")).not.toBeNull());
    expect(screen.getByText(/45.05000/)).toBeInTheDocument();
  });

  it("«удалить историю» чистит последнюю известную позицию", async () => {
    window.localStorage.setItem("fr_privacy_last_position", JSON.stringify({ lat: 45, lon: 38 }));
    renderSettings();
    const user = userEvent.setup();
    await user.click(screen.getByText("Удалить историю"));

    await waitFor(() => expect(window.localStorage.getItem("fr_privacy_last_position")).toBeNull());
    expect(screen.getByText(/удалена/)).toBeInTheDocument();
  });

  it("при сети «не отсюда» без ручной точки показывает VPN-предупреждение заранее", () => {
    markNetworkFarFromHome();
    renderSettings();

    expect(screen.getByTestId("privacy-vpn-notice")).toBeInTheDocument();
    expect(screen.getByText(/за пределами региона/)).toBeInTheDocument();
  });

  it("VPN-предупреждение исчезает, когда ручная точка задана", async () => {
    markNetworkFarFromHome();
    renderSettings();
    expect(screen.getByTestId("privacy-vpn-notice")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("широта"), "45.05");
    await user.type(screen.getByPlaceholderText("долгота"), "38.97");
    await user.click(screen.getByText("Сохранить"));

    await waitFor(() => expect(screen.queryByTestId("privacy-vpn-notice")).not.toBeInTheDocument());
  });

  it("без VPN-детекта предупреждения нет", () => {
    renderSettings();
    expect(screen.queryByTestId("privacy-vpn-notice")).not.toBeInTheDocument();
  });
});
