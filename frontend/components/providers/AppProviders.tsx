"use client";

import { MetaProvider } from "@/lib/hooks/useMeta";
import { AuthProvider } from "@/lib/hooks/useAuth";
import { ThemeProvider } from "@/lib/hooks/useTheme";
import { I18nProvider } from "@/lib/hooks/useI18n";
import { OnboardingProvider } from "@/lib/hooks/useOnboarding";
import { MapProviderPreferenceProvider } from "@/lib/hooks/useMapProviderPreference";

/** Общие провайдеры приложения — тема (R99), язык (R100), тур (R101), карта OSM/Яндекс (R102.1), справочники (/meta), профиль (/auth/me). */
export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <I18nProvider>
        <MapProviderPreferenceProvider>
          <OnboardingProvider>
            <MetaProvider>
              <AuthProvider>{children}</AuthProvider>
            </MetaProvider>
          </OnboardingProvider>
        </MapProviderPreferenceProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}
