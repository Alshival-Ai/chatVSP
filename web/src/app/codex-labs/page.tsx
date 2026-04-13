"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  modified_at?: string | null;
}

interface DirectoryResponse {
  session_id: string;
  path: string;
  entries: FileEntry[];
}

type PreviewKind = "text" | "image" | "pdf" | "html" | "unsupported";

interface PreviewState {
  path: string;
  name: string;
  kind: PreviewKind;
  mimeType: string | null;
  content?: string;
}

const CONTENT_ENDPOINT = "/api/codex-labs/files/content";

function joinPath(parentPath: string, name: string): string {
  return [parentPath, name].filter(Boolean).join("/");
}

function getParentPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function contentUrl(path: string, download = false): string {
  const params = new URLSearchParams({ path });
  if (download) {
    params.set("download", "true");
  }
  return `${CONTENT_ENDPOINT}?${params.toString()}`;
}

function formatSize(size?: number | null): string {
  if (size == null) {
    return "";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function detectPreviewKind(entry: FileEntry): PreviewKind {
  const mime = entry.mime_type?.toLowerCase() ?? "";
  const name = entry.name.toLowerCase();

  if (
    mime.startsWith("text/") ||
    mime.includes("json") ||
    mime.includes("javascript") ||
    mime.includes("xml") ||
    name.endsWith(".md") ||
    name.endsWith(".txt") ||
    name.endsWith(".py") ||
    name.endsWith(".ts") ||
    name.endsWith(".tsx") ||
    name.endsWith(".js") ||
    name.endsWith(".jsx") ||
    name.endsWith(".json") ||
    name.endsWith(".css") ||
    name.endsWith(".yml") ||
    name.endsWith(".yaml")
  ) {
    return "text";
  }

  if (mime.startsWith("image/")) {
    return "image";
  }

  if (mime.includes("pdf") || name.endsWith(".pdf")) {
    return "pdf";
  }

  if (mime.includes("html") || name.endsWith(".html") || name.endsWith(".htm")) {
    return "html";
  }

  return "unsupported";
}

async function readError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { detail?: string };
    if (payload.detail) {
      return payload.detail;
    }
  } catch {
    // Ignore parse errors and fall through.
  }

  return response.statusText || `Request failed (${response.status})`;
}

export default function CodexLabsPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [listing, setListing] = useState<DirectoryResponse | null>(null);
  const [currentPath, setCurrentPath] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [draftContent, setDraftContent] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isMutating, setIsMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedEntry = useMemo(
    () => listing?.entries.find((entry) => entry.path === selectedPath) ?? null,
    [listing, selectedPath]
  );

  const breadcrumbParts = useMemo(() => {
    const parts = currentPath.split("/").filter(Boolean);
    return parts.map((part, index) => ({
      label: part,
      path: parts.slice(0, index + 1).join("/"),
    }));
  }, [currentPath]);

  async function loadDirectory(path: string, preserveSelection = false) {
    const response = await fetch(`/api/codex-labs/files?path=${encodeURIComponent(path)}`);
    if (!response.ok) {
      throw new Error(await readError(response));
    }

    const data = (await response.json()) as DirectoryResponse;
    setListing(data);
    setCurrentPath(data.path);
    setSelectedPath((previous) => {
      if (preserveSelection && previous && data.entries.some((entry) => entry.path === previous)) {
        return previous;
      }
      return null;
    });
    if (!preserveSelection) {
      setPreview(null);
      setDraftContent("");
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function initialize() {
      try {
        setIsLoading(true);
        setError(null);

        const warmupRes = await fetch("/api/codex-labs/warmup", { method: "POST" });
        if (!warmupRes.ok) {
          throw new Error(await readError(warmupRes));
        }
        const warmup = (await warmupRes.json()) as WarmupResponse;

        if (cancelled) {
          return;
        }

        setSessionId(warmup.session_id);
        await loadDirectory(warmup.path || "");
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load Codex Labs");
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void initialize();

    return () => {
      cancelled = true;
    };
  }, []);

  async function openPreview(entry: FileEntry) {
    const kind = detectPreviewKind(entry);
    const nextPreview: PreviewState = {
      path: entry.path,
      name: entry.name,
      kind,
      mimeType: entry.mime_type ?? null,
    };

    if (kind === "text") {
      const response = await fetch(contentUrl(entry.path));
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const text = await response.text();
      nextPreview.content = text;
      setDraftContent(text);
    } else {
      setDraftContent("");
    }

    setPreview(nextPreview);
  }

  async function handleEntryClick(entry: FileEntry) {
    setSelectedPath(entry.path);
    setError(null);

    if (entry.is_directory) {
      await loadDirectory(entry.path);
      return;
    }

    try {
      await openPreview(entry);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to preview file");
    }
  }

  async function runMutation(action: () => Promise<void>) {
    try {
      setIsMutating(true);
      setError(null);
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setIsMutating(false);
    }
  }

  async function handleCreateFolder() {
    const name = window.prompt("New folder name");
    if (!name) {
      return;
    }

    await runMutation(async () => {
      const response = await fetch("/api/codex-labs/directories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parent_path: currentPath, name }),
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      await loadDirectory(currentPath, true);
    });
  }

  async function handleRename() {
    if (!selectedEntry) {
      return;
    }

    const newName = window.prompt("New name", selectedEntry.name);
    if (!newName || newName === selectedEntry.name) {
      return;
    }

    await runMutation(async () => {
      const response = await fetch("/api/codex-labs/files/rename", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: selectedEntry.path, new_name: newName }),
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const payload = (await response.json()) as { path: string };
      await loadDirectory(currentPath, false);
      setSelectedPath(payload.path);
      if (preview?.path === selectedEntry.path) {
        setPreview((existing) =>
          existing
            ? {
                ...existing,
                path: payload.path,
                name: newName,
              }
            : null
        );
      }
    });
  }

  async function handleMove() {
    if (!selectedEntry) {
      return;
    }

    const destination = window.prompt(
      "Move to directory path. Leave blank for root.",
      getParentPath(selectedEntry.path)
    );
    if (destination === null) {
      return;
    }

    await runMutation(async () => {
      const response = await fetch("/api/codex-labs/files/move", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: selectedEntry.path,
          destination_parent_path: destination,
        }),
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }

      await loadDirectory(currentPath, false);
      setSelectedPath(null);
      setPreview(null);
      setDraftContent("");
    });
  }

  async function handleDelete() {
    if (!selectedEntry) {
      return;
    }

    const confirmed = window.confirm(`Delete ${selectedEntry.name}?`);
    if (!confirmed) {
      return;
    }

    await runMutation(async () => {
      const response = await fetch(
        `/api/codex-labs/files?path=${encodeURIComponent(selectedEntry.path)}`,
        { method: "DELETE" }
      );
      if (!response.ok) {
        throw new Error(await readError(response));
      }

      await loadDirectory(currentPath, false);
      setSelectedPath(null);
      setPreview(null);
      setDraftContent("");
    });
  }

  async function handleUpload(files: FileList | null) {
    if (!files?.length) {
      return;
    }

    await runMutation(async () => {
      for (const file of Array.from(files)) {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("_path", currentPath);

        const response = await fetch("/api/codex-labs/files/upload", {
          method: "POST",
          body: formData,
        });
        if (!response.ok) {
          throw new Error(await readError(response));
        }
      }

      await loadDirectory(currentPath, true);
    });
  }

  async function handleSaveText() {
    if (!preview || preview.kind !== "text") {
      return;
    }

    await runMutation(async () => {
      const response = await fetch("/api/codex-labs/files/content", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: preview.path,
          content: draftContent,
        }),
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }

      setPreview((existing) =>
        existing
          ? {
              ...existing,
              content: draftContent,
            }
          : null
      );
      await loadDirectory(currentPath, true);
    });
  }

  const isTextDirty =
    preview?.kind === "text" && draftContent !== (preview.content ?? "");

  return (
    <div className="mx-auto flex min-h-[calc(100vh-6rem)] w-full max-w-7xl flex-col gap-6 px-6 py-10">
      <Content
        sizePreset="main-ui"
        variant="section"
        title="Codex Labs"
        description="Browse and edit a dedicated per-user workspace without touching the wider Craft pipeline."
      />

      <div className="rounded-12 border border-border-02 bg-background-000 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <button
            className="rounded-08 border border-border-01 px-3 py-1.5 text-sm hover:bg-background-tint-00 disabled:opacity-50"
            onClick={() => void loadDirectory(currentPath, true)}
            disabled={isLoading || isMutating}
          >
            Refresh
          </button>
          <button
            className="rounded-08 border border-border-01 px-3 py-1.5 text-sm hover:bg-background-tint-00 disabled:opacity-50"
            onClick={handleCreateFolder}
            disabled={isLoading || isMutating}
          >
            New Folder
          </button>
          <button
            className="rounded-08 border border-border-01 px-3 py-1.5 text-sm hover:bg-background-tint-00 disabled:opacity-50"
            onClick={() => fileInputRef.current?.click()}
            disabled={isLoading || isMutating}
          >
            Upload
          </button>
          <button
            className="rounded-08 border border-border-01 px-3 py-1.5 text-sm hover:bg-background-tint-00 disabled:opacity-50"
            onClick={handleRename}
            disabled={!selectedEntry || isMutating}
          >
            Rename
          </button>
          <button
            className="rounded-08 border border-border-01 px-3 py-1.5 text-sm hover:bg-background-tint-00 disabled:opacity-50"
            onClick={handleMove}
            disabled={!selectedEntry || isMutating}
          >
            Move
          </button>
          <button
            className="rounded-08 border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
            onClick={handleDelete}
            disabled={!selectedEntry || isMutating}
          >
            Delete
          </button>
          {selectedEntry && !selectedEntry.is_directory ? (
            <a
              className="rounded-08 border border-border-01 px-3 py-1.5 text-sm hover:bg-background-tint-00"
              href={contentUrl(selectedEntry.path, true)}
            >
              Download
            </a>
          ) : null}
          <input
            ref={fileInputRef}
            className="hidden"
            type="file"
            multiple
            onChange={(event) => void handleUpload(event.target.files)}
          />
        </div>
      </div>

      <div className="grid min-h-[60vh] gap-6 lg:grid-cols-[minmax(280px,360px)_1fr]">
        <div className="rounded-12 border border-border-02 bg-background-000 p-4">
          <div className="mb-4 flex items-center gap-2 overflow-x-auto whitespace-nowrap">
            <button
              className="rounded-08 border border-border-01 px-2 py-1 text-sm hover:bg-background-tint-00"
              onClick={() => void loadDirectory("")}
              disabled={isLoading || isMutating}
            >
              root
            </button>
            {breadcrumbParts.map((crumb) => (
              <button
                key={crumb.path}
                className="rounded-08 border border-border-01 px-2 py-1 text-sm hover:bg-background-tint-00"
                onClick={() => void loadDirectory(crumb.path)}
                disabled={isLoading || isMutating}
              >
                {crumb.label}
              </button>
            ))}
          </div>

          <Text as="p" mainUiBody className="mb-3">
            {isLoading
              ? "Warming up workspace..."
              : `Workspace ready${sessionId ? ` (${sessionId.slice(0, 12)})` : ""}`}
          </Text>

          {error ? (
            <div className="mb-4 rounded-08 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          ) : null}

          <div className="flex flex-col gap-2">
            {listing?.entries?.length ? (
              listing.entries.map((entry) => (
                <button
                  key={entry.path}
                  className={`flex items-center justify-between rounded-08 border px-3 py-2 text-left ${
                    selectedPath === entry.path
                      ? "border-border-04 bg-background-tint-02"
                      : "border-border-03 hover:bg-background-tint-00"
                  }`}
                  onClick={() => void handleEntryClick(entry)}
                >
                  <div className="min-w-0">
                    <Text as="p" mainUiBody className="truncate">
                      {entry.is_directory ? "DIR" : "FILE"} {entry.name}
                    </Text>
                    <Text as="p" mainUiBody text03 className="truncate">
                      {entry.path}
                    </Text>
                  </div>
                  <Text as="span" mainUiBody text03>
                    {entry.is_directory ? "" : formatSize(entry.size)}
                  </Text>
                </button>
              ))
            ) : (
              <Text as="p" mainUiBody text03>
                {isLoading ? "Loading..." : "This folder is empty."}
              </Text>
            )}
          </div>
        </div>

        <div className="rounded-12 border border-border-02 bg-background-000 p-4">
          <Text as="p" mainUiBody className="mb-4">
            {selectedEntry ? selectedEntry.name : "Preview"}
          </Text>

          {!selectedEntry ? (
            <Text as="p" mainUiBody text03>
              Select a file or folder from the workspace to inspect it.
            </Text>
          ) : selectedEntry.is_directory ? (
            <div className="flex h-full flex-col gap-3">
              <Text as="p" mainUiBody>
                Folder: {selectedEntry.path}
              </Text>
              <Text as="p" mainUiBody text03>
                Opened folder contents are shown in the left pane.
              </Text>
            </div>
          ) : preview?.path !== selectedEntry.path ? (
            <Text as="p" mainUiBody text03>
              Loading preview...
            </Text>
          ) : preview.kind === "text" ? (
            <div className="flex h-full flex-col gap-3">
              <textarea
                className="min-h-[420px] w-full rounded-08 border border-border-02 bg-background px-3 py-2 font-mono text-sm outline-none"
                value={draftContent}
                onChange={(event) => setDraftContent(event.target.value)}
              />
              <div className="flex items-center gap-2">
                <button
                  className="rounded-08 border border-border-01 px-3 py-1.5 text-sm hover:bg-background-tint-00 disabled:opacity-50"
                  onClick={handleSaveText}
                  disabled={!isTextDirty || isMutating}
                >
                  Save
                </button>
                <button
                  className="rounded-08 border border-border-01 px-3 py-1.5 text-sm hover:bg-background-tint-00 disabled:opacity-50"
                  onClick={() => setDraftContent(preview.content ?? "")}
                  disabled={!isTextDirty || isMutating}
                >
                  Revert
                </button>
              </div>
            </div>
          ) : preview.kind === "image" ? (
            <img
              alt={preview.name}
              className="max-h-[70vh] rounded-08 border border-border-02 object-contain"
              src={contentUrl(preview.path)}
            />
          ) : preview.kind === "pdf" || preview.kind === "html" ? (
            <iframe
              className="h-[70vh] w-full rounded-08 border border-border-02"
              src={contentUrl(preview.path)}
              title={preview.name}
            />
          ) : (
            <div className="flex flex-col gap-3">
              <Text as="p" mainUiBody text03>
                Preview is not available for this file type yet.
              </Text>
              <a
                className="w-fit rounded-08 border border-border-01 px-3 py-1.5 text-sm hover:bg-background-tint-00"
                href={contentUrl(preview.path, true)}
              >
                Download file
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
