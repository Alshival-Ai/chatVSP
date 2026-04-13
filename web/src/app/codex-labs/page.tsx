"use client";

import { useEffect, useState } from "react";
import { Content } from "@opal/layouts";
import Text from "@/refresh-components/texts/Text";

interface WarmupResponse {
  session_id: string;
  path: string;
}

interface FileEntry {
  name: string;
  path: string;
  is_directory: boolean;
  mime_type?: string | null;
  size?: number | null;
}

interface DirectoryResponse {
  session_id: string;
  path: string;
  entries: FileEntry[];
}

export default function CodexLabsPage() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [listing, setListing] = useState<DirectoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let isCancelled = false;

    async function loadWorkspace() {
      try {
        setIsLoading(true);
        setError(null);

        const warmupRes = await fetch("/api/codex-labs/warmup", {
          method: "POST",
        });
        if (!warmupRes.ok) {
          throw new Error("Failed to warm up Codex Labs workspace");
        }
        const warmup = (await warmupRes.json()) as WarmupResponse;

        const filesRes = await fetch("/api/codex-labs/files");
        if (!filesRes.ok) {
          throw new Error("Failed to load workspace files");
        }
        const files = (await filesRes.json()) as DirectoryResponse;

        if (!isCancelled) {
          setSessionId(warmup.session_id);
          setListing(files);
        }
      } catch (e) {
        if (!isCancelled) {
          setError(e instanceof Error ? e.message : "Failed to load Codex Labs");
        }
      } finally {
        if (!isCancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadWorkspace();

    return () => {
      isCancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto flex min-h-[calc(100vh-6rem)] w-full max-w-5xl flex-col gap-6 px-6 py-10">
      <Content
        sizePreset="main-ui"
        variant="section"
        title="Codex Labs"
        description="Workspace files now live in a dedicated per-user persistent volume."
      />

      <div className="rounded-12 border border-border-02 bg-background-000 p-6">
        <Text as="p" mainUiBody>
          {isLoading
            ? "Warming up workspace..."
            : error
              ? error
              : `Workspace ready${sessionId ? ` (${sessionId.slice(0, 8)})` : ""}.`}
        </Text>
      </div>

      <div className="rounded-12 border border-border-02 bg-background-000 p-6">
        <Text as="p" mainUiBody className="mb-4">
          Root files
        </Text>

        {listing?.entries?.length ? (
          <div className="flex flex-col gap-2">
            {listing.entries.map((entry) => (
              <div
                key={entry.path}
                className="flex items-center justify-between rounded-08 border border-border-03 px-3 py-2"
              >
                <Text as="span" mainUiBody>
                  {entry.is_directory ? "DIR" : "FILE"} {entry.path}
                </Text>
                {!entry.is_directory && entry.size != null ? (
                  <Text as="span" mainUiBody text03>
                    {entry.size} bytes
                  </Text>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <Text as="p" mainUiBody text03>
            {isLoading ? "Loading..." : "No visible files yet."}
          </Text>
        )}
      </div>
    </div>
  );
}
