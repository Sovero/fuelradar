import { Suspense } from "react";
import { HomeScreen } from "@/components/HomeScreen";

export default function Home() {
  return (
    <Suspense fallback={<div className="flex h-dvh items-center justify-center text-gray-400">Загрузка FuelRadar…</div>}>
      <HomeScreen />
    </Suspense>
  );
}
