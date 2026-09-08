import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AppProviders } from "@/components/providers/AppProviders";
import { ServiceWorkerRegister } from "@/components/providers/ServiceWorkerRegister";

export const metadata: Metadata = {
  title: "FuelRadar — где есть бензин",
  description: "Мониторинг наличия топлива на АЗС: статусы, достоверность, очереди.",
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#15803d",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>
        <AppProviders>
          {children}
          <ServiceWorkerRegister />
        </AppProviders>
      </body>
    </html>
  );
}