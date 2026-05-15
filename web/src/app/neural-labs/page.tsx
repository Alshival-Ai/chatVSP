import { redirect } from "next/navigation";
import type { Route } from "next";
import { createHmac } from "node:crypto";
import { NEURAL_LABS_DESKTOP_URL } from "@/lib/constants";
import { requireAuth } from "@/lib/auth/requireAuth";
import { fetchSettingsSS } from "@/components/settings/lib";
import { UserRole } from "@/lib/types";

const DEFAULT_NEURAL_LABS_DESKTOP_PATH = "/neural-labs-app/desktop";
const TRUSTED_LOGIN_PATH = "/api/auth/trusted-login";
const HANDOFF_TOKEN_TTL_SECONDS = 60;

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function getHandoffSecret(): string {
  return (
    process.env.NEURAL_LABS_AUTH_SHARED_SECRET?.trim() ||
    process.env.USER_AUTH_SECRET?.trim() ||
    ""
  );
}

function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function buildHandoffToken({
  email,
  role,
}: {
  email: string;
  role: "admin" | "user";
}): string | null {
  const secret = getHandoffSecret();
  if (!secret) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  const payload = base64UrlEncode(
    JSON.stringify({
      email,
      role,
      iat: now,
      exp: now + HANDOFF_TOKEN_TTL_SECONDS,
    })
  );

  return `${payload}.${signPayload(payload, secret)}`;
}

function normalizeDesktopUrl(rawUrl: string): URL {
  const trimmed = rawUrl.trim() || DEFAULT_NEURAL_LABS_DESKTOP_PATH;

  if (trimmed.startsWith("/")) {
    const parsed = new URL(trimmed, "http://chatvsp.local");
    if (parsed.pathname === "/") {
      parsed.pathname = DEFAULT_NEURAL_LABS_DESKTOP_PATH;
    }
    return parsed;
  }

  const parsed = new URL(trimmed);
  if (parsed.pathname === "/" || parsed.pathname === "") {
    parsed.pathname = "/desktop";
  }
  return parsed;
}

function buildTrustedLoginUrl(desktopUrl: URL, token: string): string {
  const trustedLoginUrl = new URL(desktopUrl.toString());
  trustedLoginUrl.pathname = desktopUrl.pathname.replace(
    /\/desktop\/?$/,
    TRUSTED_LOGIN_PATH
  );
  trustedLoginUrl.search = "";
  trustedLoginUrl.searchParams.set("token", token);
  trustedLoginUrl.searchParams.set(
    "next",
    `${desktopUrl.pathname}${desktopUrl.search}`
  );

  if (trustedLoginUrl.origin === "http://chatvsp.local") {
    return `${trustedLoginUrl.pathname}${trustedLoginUrl.search}`;
  }

  return trustedLoginUrl.toString();
}

export default async function NeuralLabsPage() {
  const authResult = await requireAuth();
  if (authResult.redirect) {
    redirect(authResult.redirect as Route);
  }

  const settings = await fetchSettingsSS();
  if (settings?.settings?.neural_labs_enabled !== true || !authResult.user) {
    redirect("/app" as Route);
  }

  const token = buildHandoffToken({
    email: authResult.user.email,
    role: authResult.user.role === UserRole.ADMIN ? "admin" : "user",
  });
  if (!token) {
    redirect("/app" as Route);
  }

  redirect(
    buildTrustedLoginUrl(
      normalizeDesktopUrl(NEURAL_LABS_DESKTOP_URL),
      token
    ) as Route
  );
}
