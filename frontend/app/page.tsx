export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-3xl font-bold">FuelRadar</h1>
      <p className="text-gray-600">Мониторинг наличия топлива на АЗС.</p>
      <p className="text-sm text-gray-400">
        Карта, список и фильтры появятся на следующем этапе сборки.
      </p>
    </main>
  );
}