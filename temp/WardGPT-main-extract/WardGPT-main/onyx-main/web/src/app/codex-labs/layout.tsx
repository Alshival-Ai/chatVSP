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
  const userHasCodexLabsAccess = authResult.user?.enable_codex_labs === true;
  if (settings?.settings?.codex_labs_enabled !== true && !userHasCodexLabsAccess) {
    redirect("/app" as Route);
  }

  return <>{children}</>;
}
