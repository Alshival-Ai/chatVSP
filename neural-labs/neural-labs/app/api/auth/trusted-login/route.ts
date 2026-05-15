import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { applySessionCookie, loginWithTrustedUser } from "@/lib/server/auth";
import { jsonErrorFromUnknown } from "@/lib/server/http";
import { syncOnyxProvidersForUser } from "@/lib/server/onyx-provider-sync";
import { withBasePath } from "@/lib/shared/base-path";

export const runtime = "nodejs";

type TrustedLoginRole = "admin" | "user";

interface TrustedLoginPayload {
  email?: string;
  role?: TrustedLoginRole;
  exp?: number;
}

function getTrustedAuthSecret(): string {
  return (
    process.env.NEURAL_LABS_AUTH_SHARED_SECRET?.trim() ||
    process.env.USER_AUTH_SECRET?.trim() ||
    ""
  );
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseTrustedToken(token: string): TrustedLoginPayload {
  const [payload, signature] = token.split(".");
  const secret = getTrustedAuthSecret();

  if (!payload || !signature || !secret) {
    throw new Error("Trusted login is not configured");
  }

  const expectedSignature = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  if (!safeEqual(signature, expectedSignature)) {
    throw new Error("Invalid trusted login token");
  }

  const parsed = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as TrustedLoginPayload;
  if (
    !parsed.email ||
    !parsed.exp ||
    parsed.exp < Math.floor(Date.now() / 1000)
  ) {
    throw new Error("Expired trusted login token");
  }

  return parsed;
}

function normalizeNextPath(nextPath: string | null): string {
  if (!nextPath || !nextPath.startsWith("/") || nextPath.startsWith("//")) {
    return withBasePath("/desktop");
  }

  return nextPath;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const payload = parseTrustedToken(url.searchParams.get("token") || "");
    const result = loginWithTrustedUser(
      payload.email || "",
      payload.role === "admin" ? "admin" : "user",
    );
    try {
      await syncOnyxProvidersForUser(result.viewer.id, payload.email || "");
    } catch (error) {
      console.warn("Unable to sync Onyx providers for Neural Labs", error);
    }

    return applySessionCookie(
      new NextResponse(null, {
        status: 307,
        headers: {
          Location: normalizeNextPath(url.searchParams.get("next")),
        },
      }),
      result.sessionToken,
    );
  } catch (error) {
    return jsonErrorFromUnknown(error, "Unable to complete trusted login", 401);
  }
}
