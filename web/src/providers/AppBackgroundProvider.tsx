"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useUser } from "@/providers/UserProvider";
import { useTheme } from "next-themes";
import {
  CHAT_BACKGROUND_NONE,
  getBackgroundById,
  ChatBackgroundOption,
} from "@/lib/constants/chatBackgrounds";

interface AppBackgroundContextType {
  /** The full background option object, or undefined if none/invalid */
  appBackground: ChatBackgroundOption | undefined;
  /** The URL of the background image, or null if no background is set */
  appBackgroundUrl: string | null;
  /** Whether a background is currently active */
  hasBackground: boolean;
}

const AppBackgroundContext = createContext<
  AppBackgroundContextType | undefined
>(undefined);

export function AppBackgroundProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user } = useUser();
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const value = useMemo(() => {
    const hasThemeSpecificBackgrounds =
      user?.preferences?.light_chat_background !== null ||
      user?.preferences?.dark_chat_background !== null;
    const chatBackgroundId = mounted
      ? resolvedTheme === "dark"
        ? hasThemeSpecificBackgrounds
          ? user?.preferences?.dark_chat_background
          : user?.preferences?.chat_background
        : hasThemeSpecificBackgrounds
          ? user?.preferences?.light_chat_background
          : user?.preferences?.chat_background
      : user?.preferences?.chat_background;
    const appBackground = getBackgroundById(chatBackgroundId ?? null);
    const hasBackground =
      !!appBackground && appBackground.src !== CHAT_BACKGROUND_NONE;
    const appBackgroundUrl = hasBackground ? appBackground.src : null;

    return {
      appBackground,
      appBackgroundUrl,
      hasBackground,
    };
  }, [
    mounted,
    resolvedTheme,
    user?.preferences?.chat_background,
    user?.preferences?.dark_chat_background,
    user?.preferences?.light_chat_background,
  ]);

  return (
    <AppBackgroundContext.Provider value={value}>
      {children}
    </AppBackgroundContext.Provider>
  );
}

export function useAppBackground() {
  const context = useContext(AppBackgroundContext);
  if (context === undefined) {
    throw new Error(
      "useAppBackground must be used within an AppBackgroundProvider"
    );
  }
  return context;
}
