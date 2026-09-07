import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FuelRadar — где есть бензин",
  description: "Мониторинг наличия топлива на АЗС: статусы, достоверность, очереди.",
  manifest: "/manifest.json",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}