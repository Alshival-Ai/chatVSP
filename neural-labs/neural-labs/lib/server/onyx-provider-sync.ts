import { createHmac } from "node:crypto";

import {
  syncManagedOnyxProviders,
  type OnyxProviderConfig,
} from "@/lib/server/store";

interface OnyxProviderSyncEntry {
  managedKey?: string;
  name?: string;
  kind?: string;
  model?: string;
  region?: string;
  isDefault?: boolean;
}

interface OnyxProviderSyncResponse {
  providers?: OnyxProviderSyncEntry[];
}

function getSharedSecret(): string {
  return (
    process.env.NEURAL_LABS_AUTH_SHARED_SECRET?.trim() ||
    process.env.USER_AUTH_SECRET?.trim() ||
    ""
  );
}

function getOnyxInternalUrl(): string {
  return (
    process.env.ONYX_INTERNAL_URL?.trim() ||
    process.env.INTERNAL_URL?.trim() ||
    "http://api_server:8080"
  ).replace(/\/$/, "");
}

function buildSignature(timestamp: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}:provider-sync`)
    .digest("hex");
}

function normalizeProviderConfig(provider: OnyxProviderSyncEntry): OnyxProviderConfig | null {
  if (
    !provider.managedKey?.startsWith("onyx:") ||
    provider.kind !== "bedrock" ||
    !provider.name ||
    !provider.model
  ) {
    return null;
  }

  return {
    managedKey: provider.managedKey as OnyxProviderConfig["managedKey"],
    name: provider.name,
    kind: "bedrock",
    model: provider.model,
    baseUrl: "",
    apiKey: "",
    region: provider.region,
    isDefault: provider.isDefault,
  };
}

export async function syncOnyxProvidersForUser(
  userId: string,
  email: string
): Promise<void> {
  if (process.env.NEURAL_LABS_ONYX_PROVIDER_SYNC === "false") {
    return;
  }

  const secret = getSharedSecret();
  if (!secret || !email.trim()) {
    return;
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const url = new URL(`${getOnyxInternalUrl()}/neural-labs/provider-sync`);
  url.searchParams.set("email", email.trim());

  const response = await fetch(url, {
    headers: {
      "x-neural-labs-sync-timestamp": timestamp,
      "x-neural-labs-sync-signature": buildSignature(timestamp, secret),
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Onyx provider sync failed with HTTP ${response.status}`);
  }

  const payload = (await response.json()) as OnyxProviderSyncResponse;
  const providers = (payload.providers ?? [])
    .map(normalizeProviderConfig)
    .filter((provider): provider is OnyxProviderConfig => Boolean(provider));

  await syncManagedOnyxProviders(userId, providers);
}
