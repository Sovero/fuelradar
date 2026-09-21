"use client";

import { MetaProvider } from "@/lib/hooks/useMeta";
import { ThemeProvider } from "@/lib/hooks/useTheme";
import { I18nProvider } from "@/lib/hooks/useI18n";
import { OnboardingProvider } from "@/lib/hooks/useOnboarding";
import { MapProviderPreferenceProvider } from "@/lib/hooks/useMapProviderPreference";
import { PrivacyProvider } from "@/lib/hooks/usePrivacy";
import { ObservationModeProvider } from "@/lib/hooks/useObservationMode";
import { NetworkPreferencesProvider } from "@/lib/hooks/useNetworkPreferences";

/**
 * Общие провайдеры приложения — тема (R99), язык (R100), тур (R101), карта
 * OSM/Яндекс (R102.1), справочники (/meta), приватность геолокации (R24),
 * режим наблюдения (R25) и предпочтения сетей (R77). Профиля в приложении
 * нет — AuthProvider/BootstrapGate удалены вместе с пользователями.
 */
export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <I18nProvider>
        <MapProviderPreferenceProvider>
          <OnboardingProvider>
            <MetaProvider>
              <PrivacyProvider>
                <ObservationModeProvider>
                  <NetworkPreferencesProvider>{children}</NetworkPreferencesProvider>
                </ObservationModeProvider>
              </PrivacyProvider>
            </MetaProvider>
          </OnboardingProvider>
        </MapProviderPreferenceProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}
