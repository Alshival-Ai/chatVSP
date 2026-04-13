import { redirect } from "next/navigation";
import type { Route } from "next";
import { unstable_noStore as noStore } from "next/cache";
import { requireAuth } from "@/lib/auth/requireAuth";
import { fetchSettingsSS } from "@/components/settings/lib";

interface CodexLabsLayoutProps {
  children: React.ReactNode;
}

export default async function CodexLabsLayout({
  children,
}: CodexLabsLayoutProps) {
  noStore();

  const authResult = await requireAuth();
  if (authResult.redirect) {
    redirect(authResult.redirect as Route);
  }

  const settings = await fetchSettingsSS();
  if (settings?.settings?.codex_labs_enabled !== true) {
    redirect("/app" as Route);
  }

  return <>{children}</>;
}
