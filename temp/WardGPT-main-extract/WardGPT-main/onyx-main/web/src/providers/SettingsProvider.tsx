"use client";

import { CombinedSettings } from "@/interfaces/settings";
import { Settings as UserSettings } from "@/interfaces/settings";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useMemo,
  JSX,
} from "react";
import useSWR from "swr";
import useCCPairs from "@/hooks/useCCPairs";
import { errorHandlingFetcher } from "@/lib/fetcher";

export function SettingsProvider({
  children,
  settings,
}: {
  children: React.ReactNode | JSX.Element;
  settings: CombinedSettings;
}) {
  const [isMobile, setIsMobile] = useState<boolean | undefined>();
  const { data: refreshedSettings } = useSWR<UserSettings>(
    "/api/settings",
    errorHandlingFetcher
  );

  const effectiveSettings = refreshedSettings ?? settings.settings;
  const vectorDbEnabled = effectiveSettings.vector_db_enabled !== false;
  const { ccPairs } = useCCPairs(vectorDbEnabled);

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
    };

    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  /**
   * NOTE (@raunakab):
   * Whether search mode is actually available to users.
   *
   * Prefer `isSearchModeAvailable` over `settings.search_ui_enabled`.
   * The raw setting only captures the admin's *intent*. This derived value
   * also checks runtime prerequisites (connectors must exist) so that
   * consumers don't need to independently verify availability.
   */
  const isSearchModeAvailable = useMemo(
    () => effectiveSettings.search_ui_enabled !== false && ccPairs.length > 0,
    [effectiveSettings.search_ui_enabled, ccPairs.length]
  );

  const combinedSettings = useMemo(
    () => ({
      ...settings,
      settings: effectiveSettings,
      isMobile,
      isSearchModeAvailable,
    }),
    [settings, effectiveSettings, isMobile, isSearchModeAvailable]
  );

  return (
    <SettingsContext.Provider value={combinedSettings}>
      {children}
    </SettingsContext.Provider>
  );
}

export const SettingsContext = createContext<CombinedSettings | null>(null);

export function useSettingsContext() {
  const context = useContext(SettingsContext);
  if (context === null) {
    throw new Error(
      "useSettingsContext must be used within a SettingsProvider"
    );
  }
  return context;
}

export function useVectorDbEnabled(): boolean {
  const settings = useSettingsContext();
  return settings.settings.vector_db_enabled !== false;
}
