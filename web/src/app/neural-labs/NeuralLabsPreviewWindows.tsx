"use client";

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import dynamic from "next/dynamic";
import JSZip from "jszip";
import { kml as kmlToGeoJson } from "@tmcw/togeojson";
import Text from "@/refresh-components/texts/Text";
import { SvgFileText, SvgImage, SvgRefreshCw, SvgX } from "@opal/icons";
import { PreviewWindowState, type PreviewSnapZone } from "@/app/neural-labs/types";
import type { GeoJsonObject } from "geojson";

interface WorkspaceBounds {
  width: number;
  height: number;
}

interface NeuralLabsPreviewWindowsProps {
  windows: PreviewWindowState[];
  workspaceBounds: WorkspaceBounds;
  currentDirectory: string;
  onCloseWindow: (windowId: string) => void;
  onFocusWindow: (windowId: string) => void;
  onTextFileSaved?: (path: string) => void;
  onUpdateWindow: (
    windowId: string,
    update:
      | Partial<PreviewWindowState>
      | ((windowState: PreviewWindowState) => PreviewWindowState)
  ) => void;
}

type ResizeDirection =
  | "n"
  | "ne"
  | "e"
  | "se"
  | "s"
  | "sw"
  | "w"
  | "nw";

interface DragInteraction {
  mode: "drag";
  pointerX: number;
  pointerY: number;
  windowState: PreviewWindowState;
}

interface ResizeInteraction {
  mode: "resize";
  pointerX: number;
  pointerY: number;
  direction: ResizeDirection;
  windowState: PreviewWindowState;
}

type InteractionState = DragInteraction | ResizeInteraction;

const CONTENT_API_PREFIX = "/api/neural-labs/files/content";
const SNAP_THRESHOLD = 28;
const WINDOW_GAP = 10;
const MIN_WINDOW_WIDTH = 280;
const MIN_WINDOW_HEIGHT = 220;
const MAX_XLSX_PREVIEW_ROWS = 200;
const MAX_XLSX_PREVIEW_COLUMNS = 40;
const NeuralLabsKmzMap = dynamic(() => import("./NeuralLabsKmzMap"), {
  ssr: false,
});

interface XlsxSheetPreview {
  name: string;
  rows: string[][];
  columnCount: number;
}

interface XlsxPreviewData {
  sheets: XlsxSheetPreview[];
  truncatedRows: boolean;
  truncatedColumns: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getContentUrl(path: string): string {
  return `${CONTENT_API_PREFIX}?path=${encodeURIComponent(path)}`;
}

function looksLikeKml(name: string, mimeType: string): boolean {
  const lowerName = name.toLowerCase();
  const lowerMime = mimeType.toLowerCase();
  return (
    lowerName.endsWith(".kml") ||
    lowerMime.includes("application/vnd.google-earth.kml+xml") ||
    lowerMime.includes("kml")
  );
}

async function extractKmlText(blob: Blob, fileName: string): Promise<string> {
  if (looksLikeKml(fileName, blob.type)) {
    return blob.text();
  }

  const zip = await JSZip.loadAsync(blob);
  const names = Object.keys(zip.files).filter((name) => {
    const entry = zip.files[name];
    return Boolean(entry && !entry.dir && name.toLowerCase().endsWith(".kml"));
  });

  if (names.length === 0) {
    throw new Error("No KML file found inside KMZ.");
  }

  const preferredName =
    names.find((name) => name.toLowerCase().endsWith("doc.kml")) || names[0];
  if (!preferredName) {
    throw new Error("No KML file found inside KMZ.");
  }

  const kmlEntry = zip.file(preferredName);
  if (!kmlEntry) {
    throw new Error("Failed to read KML content from KMZ.");
  }

  return kmlEntry.async("text");
}

function toGeoJson(kmlText: string): GeoJsonObject {
  const xml = new DOMParser().parseFromString(kmlText, "application/xml");
  const parserError = xml.querySelector("parsererror");
  if (parserError) {
    throw new Error("KML parser error.");
  }

  const geoJson = kmlToGeoJson(xml) as GeoJsonObject;
  if (!geoJson || !("type" in geoJson)) {
    throw new Error("Failed to convert KML to GeoJSON.");
  }

  return geoJson;
}

function hasRenderableFeatures(geoJson: GeoJsonObject): boolean {
  const candidate = geoJson as { type?: string; features?: unknown[]; geometry?: unknown };
  if (candidate.type === "FeatureCollection") {
    return Array.isArray(candidate.features) && candidate.features.length > 0;
  }
  if (candidate.type === "Feature") {
    return Boolean(candidate.geometry);
  }
  return true;
}

async function readResponseError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as Record<string, unknown>;
    if (typeof payload.message === "string") {
      return payload.message;
    }
    if (typeof payload.detail === "string") {
      return payload.detail;
    }
    if (typeof payload.error_code === "string") {
      return payload.error_code;
    }
  } catch {
    // Ignore parse errors and use status text fallback.
  }

  return response.statusText || `Request failed (${response.status})`;
}

function getSnappedBounds(
  zone: PreviewSnapZone,
  workspaceBounds: WorkspaceBounds
): Pick<PreviewWindowState, "x" | "y" | "width" | "height"> {
  const width = Math.max(
    MIN_WINDOW_WIDTH,
    Math.floor((workspaceBounds.width - WINDOW_GAP * 3) / 2)
  );
  const height = Math.max(
    MIN_WINDOW_HEIGHT,
    Math.floor((workspaceBounds.height - WINDOW_GAP * 3) / 2)
  );
  const fullWidth = Math.max(MIN_WINDOW_WIDTH, workspaceBounds.width - WINDOW_GAP * 2);
  const fullHeight = Math.max(
    MIN_WINDOW_HEIGHT,
    workspaceBounds.height - WINDOW_GAP * 2
  );
  const rightX = Math.max(WINDOW_GAP, workspaceBounds.width - width - WINDOW_GAP);
  const bottomY = Math.max(WINDOW_GAP, workspaceBounds.height - height - WINDOW_GAP);

  switch (zone) {
    case "left":
      return { x: WINDOW_GAP, y: WINDOW_GAP, width, height: fullHeight };
    case "right":
      return { x: rightX, y: WINDOW_GAP, width, height: fullHeight };
    case "top":
      return { x: WINDOW_GAP, y: WINDOW_GAP, width: fullWidth, height };
    case "bottom":
      return { x: WINDOW_GAP, y: bottomY, width: fullWidth, height };
    case "top-left":
      return { x: WINDOW_GAP, y: WINDOW_GAP, width, height };
    case "top-right":
      return { x: rightX, y: WINDOW_GAP, width, height };
    case "bottom-left":
      return { x: WINDOW_GAP, y: bottomY, width, height };
    case "bottom-right":
      return { x: rightX, y: bottomY, width, height };
  }
}

function clampWindowToWorkspace(
  windowState: PreviewWindowState,
  workspaceBounds: WorkspaceBounds
): PreviewWindowState {
  if (workspaceBounds.width <= 0 || workspaceBounds.height <= 0) {
    return windowState;
  }

  if (windowState.snapped_zone) {
    return {
      ...windowState,
      ...getSnappedBounds(windowState.snapped_zone, workspaceBounds),
    };
  }

  const maxWidth = Math.max(MIN_WINDOW_WIDTH, workspaceBounds.width - WINDOW_GAP * 2);
  const maxHeight = Math.max(MIN_WINDOW_HEIGHT, workspaceBounds.height - WINDOW_GAP * 2);
  const width = clamp(windowState.width, MIN_WINDOW_WIDTH, maxWidth);
  const height = clamp(windowState.height, MIN_WINDOW_HEIGHT, maxHeight);
  const x = clamp(windowState.x, WINDOW_GAP, workspaceBounds.width - width - WINDOW_GAP);
  const y = clamp(
    windowState.y,
    WINDOW_GAP,
    workspaceBounds.height - height - WINDOW_GAP
  );

  return { ...windowState, x, y, width, height };
}

function detectSnapZone(
  x: number,
  y: number,
  width: number,
  height: number,
  workspaceBounds: WorkspaceBounds
): PreviewSnapZone | null {
  const nearLeft = x <= SNAP_THRESHOLD;
  const nearRight = x + width >= workspaceBounds.width - SNAP_THRESHOLD;
  const nearTop = y <= SNAP_THRESHOLD;
  const nearBottom = y + height >= workspaceBounds.height - SNAP_THRESHOLD;

  if (nearTop && nearLeft) {
    return "top-left";
  }
  if (nearTop && nearRight) {
    return "top-right";
  }
  if (nearBottom && nearLeft) {
    return "bottom-left";
  }
  if (nearBottom && nearRight) {
    return "bottom-right";
  }
  if (nearLeft) {
    return "left";
  }
  if (nearRight) {
    return "right";
  }
  if (nearTop) {
    return "top";
  }
  if (nearBottom) {
    return "bottom";
  }
  return null;
}

function getXmlDocument(xmlText: string): Document {
  const xml = new DOMParser().parseFromString(xmlText, "application/xml");
  const parserError = xml.querySelector("parsererror");
  if (parserError) {
    throw new Error("Spreadsheet XML parser error.");
  }
  return xml;
}

function getAttributeValue(element: Element, attributeName: string): string | null {
  return (
    element.getAttribute(attributeName) ??
    Array.from(element.attributes).find((attribute) =>
      attribute.name.endsWith(`:${attributeName}`)
    )?.value ??
    null
  );
}

function columnNameToIndex(reference: string): number {
  const letters = reference.match(/[A-Z]+/i)?.[0]?.toUpperCase() ?? "";
  let value = 0;
  for (const letter of letters) {
    value = value * 26 + (letter.charCodeAt(0) - 64);
  }
  return Math.max(0, value - 1);
}

function normalizeZipPath(basePath: string, targetPath: string): string {
  if (!targetPath) {
    return basePath;
  }
  if (targetPath.startsWith("/")) {
    return targetPath.replace(/^\/+/, "");
  }

  const baseSegments = basePath.split("/").filter(Boolean);
  baseSegments.pop();
  const targetSegments = targetPath.split("/").filter(Boolean);

  for (const segment of targetSegments) {
    if (segment === ".") {
      continue;
    }
    if (segment === "..") {
      baseSegments.pop();
      continue;
    }
    baseSegments.push(segment);
  }

  return baseSegments.join("/");
}

function readSharedStringValue(sharedString: Element): string {
  const textNodes = Array.from(sharedString.getElementsByTagNameNS("*", "t"));
  if (textNodes.length === 0) {
    return sharedString.textContent ?? "";
  }
  return textNodes.map((node) => node.textContent ?? "").join("");
}

function readWorksheetCellValue(cell: Element, sharedStrings: string[]): string {
  const cellType = cell.getAttribute("t") ?? "";

  if (cellType === "inlineStr") {
    const inlineText = Array.from(cell.getElementsByTagNameNS("*", "t"))
      .map((node) => node.textContent ?? "")
      .join("");
    return inlineText;
  }

  const valueNode = cell.getElementsByTagNameNS("*", "v")[0] ?? null;
  const rawValue = valueNode?.textContent ?? "";

  if (cellType === "s") {
    const sharedStringIndex = Number.parseInt(rawValue, 10);
    return Number.isFinite(sharedStringIndex)
      ? sharedStrings[sharedStringIndex] ?? ""
      : "";
  }
  if (cellType === "b") {
    return rawValue === "1" ? "TRUE" : "FALSE";
  }

  return rawValue;
}

async function extractXlsxPreviewData(blob: Blob): Promise<XlsxPreviewData> {
  const zip = await JSZip.loadAsync(blob);
  const workbookEntry = zip.file("xl/workbook.xml");
  const relsEntry = zip.file("xl/_rels/workbook.xml.rels");

  if (!workbookEntry || !relsEntry) {
    throw new Error("Spreadsheet structure is incomplete.");
  }

  const workbookXml = getXmlDocument(await workbookEntry.async("text"));
  const relsXml = getXmlDocument(await relsEntry.async("text"));

  const relTargetById = new Map<string, string>();
  Array.from(relsXml.getElementsByTagNameNS("*", "Relationship")).forEach((rel) => {
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    if (!id || !target) {
      return;
    }
    relTargetById.set(id, normalizeZipPath("xl/workbook.xml", target));
  });

  const sharedStringsEntry = zip.file("xl/sharedStrings.xml");
  const sharedStrings = sharedStringsEntry
    ? Array.from(
        getXmlDocument(await sharedStringsEntry.async("text")).getElementsByTagNameNS(
          "*",
          "si"
        )
      ).map(readSharedStringValue)
    : [];

  const sheets = Array.from(workbookXml.getElementsByTagNameNS("*", "sheet"));
  if (sheets.length === 0) {
    throw new Error("Spreadsheet has no visible sheets.");
  }

  let truncatedRows = false;
  let truncatedColumns = false;

  const parsedSheets = await Promise.all(
    sheets.map(async (sheet, sheetIndex) => {
      const name = sheet.getAttribute("name") ?? `Sheet ${sheetIndex + 1}`;
      const relationshipId =
        getAttributeValue(sheet, "r:id") ??
        Array.from(sheet.attributes).find((attribute) =>
          attribute.name.endsWith(":id")
        )?.value;
      if (!relationshipId) {
        throw new Error(`Unable to resolve sheet "${name}".`);
      }

      const worksheetPath = relTargetById.get(relationshipId);
      const worksheetEntry = worksheetPath ? zip.file(worksheetPath) : null;
      if (!worksheetEntry) {
        throw new Error(`Worksheet file missing for "${name}".`);
      }

      const worksheetXml = getXmlDocument(await worksheetEntry.async("text"));
      const rowNodes = Array.from(worksheetXml.getElementsByTagNameNS("*", "row"));
      if (rowNodes.length > MAX_XLSX_PREVIEW_ROWS) {
        truncatedRows = true;
      }

      const rows: string[][] = [];
      let maxColumnIndex = 0;

      rowNodes.slice(0, MAX_XLSX_PREVIEW_ROWS).forEach((rowNode, rowIndex) => {
        const rowValues: string[] = [];
        const cellNodes = Array.from(rowNode.getElementsByTagNameNS("*", "c"));

        cellNodes.forEach((cellNode, fallbackColumnIndex) => {
          const reference = cellNode.getAttribute("r") ?? "";
          const columnIndex = reference
            ? columnNameToIndex(reference)
            : fallbackColumnIndex;

          if (columnIndex >= MAX_XLSX_PREVIEW_COLUMNS) {
            truncatedColumns = true;
            return;
          }

          while (rowValues.length <= columnIndex) {
            rowValues.push("");
          }
          rowValues[columnIndex] = readWorksheetCellValue(cellNode, sharedStrings);
          maxColumnIndex = Math.max(maxColumnIndex, columnIndex);
        });

        rows[rowIndex] = rowValues;
      });

      const columnCount = Math.min(MAX_XLSX_PREVIEW_COLUMNS, maxColumnIndex + 1);
      return {
        name,
        rows: rows.map((row) => {
          const normalizedRow = Array.from({ length: columnCount }, (_, index) =>
            row[index] ?? ""
          );
          return normalizedRow;
        }),
        columnCount,
      };
    })
  );

  return {
    sheets: parsedSheets,
    truncatedRows,
    truncatedColumns,
  };
}

function columnIndexToLabel(index: number): string {
  let current = index + 1;
  let label = "";

  while (current > 0) {
    const remainder = (current - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    current = Math.floor((current - 1) / 26);
  }

  return label;
}

function TextEditorContent({
  windowState,
  onTextFileSaved,
}: {
  windowState: PreviewWindowState;
  onTextFileSaved?: (path: string) => void;
}) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [textValue, setTextValue] = useState("");
  const [savedValue, setSavedValue] = useState("");

  const contentUrl = useMemo(() => {
    const suffix = refreshKey > 0 ? `&refresh=${refreshKey}` : "";
    return `${getContentUrl(windowState.path)}${suffix}`;
  }, [refreshKey, windowState.path]);

  const loadText = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);
    setStatusMessage(null);

    try {
      const response = await fetch(contentUrl, {
        headers: { Accept: "text/plain" },
      });
      if (!response.ok) {
        throw new Error(await readResponseError(response));
      }

      const content = await response.text();
      setTextValue(content);
      setSavedValue(content);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to load text file"
      );
      setTextValue("");
      setSavedValue("");
    } finally {
      setIsLoading(false);
    }
  }, [contentUrl]);

  useEffect(() => {
    void loadText();
  }, [loadText]);

  const hasUnsavedChanges = textValue !== savedValue;

  const saveText = useCallback(async () => {
    if (isSaving || isLoading || !hasUnsavedChanges) {
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const response = await fetch(CONTENT_API_PREFIX, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: windowState.path,
          content: textValue,
        }),
      });

      if (!response.ok) {
        throw new Error(await readResponseError(response));
      }

      setSavedValue(textValue);
      setStatusMessage("Saved");
      onTextFileSaved?.(windowState.path);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to save file"
      );
    } finally {
      setIsSaving(false);
    }
  }, [
    hasUnsavedChanges,
    isLoading,
    isSaving,
    onTextFileSaved,
    textValue,
    windowState.path,
  ]);

  return (
    <div className="flex h-full w-full flex-col bg-background-neutral-00">
      <div className="flex items-center justify-between border-b border-border-01 px-2 py-1.5">
        <Text text03 className="truncate text-xs">
          {errorMessage
            ? errorMessage
            : isLoading
              ? "Loading..."
              : isSaving
                ? "Saving..."
                : hasUnsavedChanges
                  ? "Unsaved changes"
                  : statusMessage ?? "Ready"}
        </Text>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="rounded-08 border border-border-01 px-2 py-0.5 text-xs hover:bg-background-neutral-01"
            onClick={() => setRefreshKey((value) => value + 1)}
            disabled={isLoading || isSaving}
            title="Reload from disk"
          >
            Reload
          </button>
          <button
            type="button"
            className="rounded-08 border border-border-01 px-2 py-0.5 text-xs hover:bg-background-neutral-01 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => void saveText()}
            disabled={!hasUnsavedChanges || isSaving || isLoading}
            title="Save (Ctrl/Cmd+S)"
          >
            Save
          </button>
        </div>
      </div>
      <textarea
        spellCheck={false}
        value={textValue}
        onChange={(event) => {
          setTextValue(event.target.value);
          if (statusMessage) {
            setStatusMessage(null);
          }
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();
            void saveText();
          }
        }}
        className="h-[calc(100%-2.25rem)] w-full resize-none border-0 bg-background-neutral-00 px-3 py-2 font-mono text-sm leading-5 text-text-00 outline-none"
      />
    </div>
  );
}

function AppTextEditorContent({
  currentDirectory,
  onTextFileSaved,
}: {
  currentDirectory: string;
  onTextFileSaved?: (path: string) => void;
}) {
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>("Ready");
  const [textValue, setTextValue] = useState("");

  const saveText = useCallback(async () => {
    const promptDefault = currentDirectory
      ? `${currentDirectory}/untitled.txt`
      : "untitled.txt";
    const targetInput = window.prompt("Save text as:", promptDefault);
    if (targetInput === null) {
      return;
    }

    const trimmedTarget = targetInput.trim().replace(/^\/+/, "");
    if (!trimmedTarget) {
      setStatusMessage("File name cannot be empty");
      return;
    }

    const targetPath =
      currentDirectory && !trimmedTarget.includes("/")
        ? `${currentDirectory}/${trimmedTarget}`
        : trimmedTarget;

    setIsSaving(true);
    setStatusMessage("Saving...");

    try {
      const response = await fetch(CONTENT_API_PREFIX, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: targetPath,
          content: textValue,
        }),
      });

      if (!response.ok) {
        throw new Error(await readResponseError(response));
      }

      setStatusMessage("Saved");
      onTextFileSaved?.(targetPath);
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Unable to save file"
      );
    } finally {
      setIsSaving(false);
    }
  }, [currentDirectory, onTextFileSaved, textValue]);

  return (
    <div className="flex h-full w-full flex-col bg-background-neutral-00">
      <div className="flex items-center justify-between border-b border-border-01 px-2 py-1.5">
        <Text text03 className="truncate text-xs">
          {isSaving
            ? "Saving..."
            : statusMessage ?? (textValue.trim() ? "Unsaved changes" : "Ready")}
        </Text>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="rounded-08 border border-border-01 px-2 py-0.5 text-xs hover:bg-background-neutral-01 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => {
              setTextValue("");
              setStatusMessage("Ready");
            }}
            disabled={!textValue.trim() || isSaving}
          >
            Clear
          </button>
          <button
            type="button"
            className="rounded-08 border border-border-01 px-2 py-0.5 text-xs hover:bg-background-neutral-01 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => void saveText()}
            disabled={!textValue.trim() || isSaving}
          >
            Save to File
          </button>
        </div>
      </div>
      <div className="border-b border-border-01 px-2 py-1.5">
        <Text text03 className="truncate text-xs">
          {`Saving to: ${currentDirectory ? `~/${currentDirectory}` : "~"}`}
        </Text>
      </div>
      <textarea
        spellCheck={false}
        value={textValue}
        onChange={(event) => {
          setTextValue(event.target.value);
          setStatusMessage(null);
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();
            void saveText();
          }
        }}
        placeholder="Paste or type text here..."
        className="h-[calc(100%-4.5rem)] w-full resize-none border-0 bg-background-neutral-00 px-3 py-2 font-mono text-sm leading-5 text-text-00 outline-none"
      />
    </div>
  );
}

function KmzMapContent({ windowState }: { windowState: PreviewWindowState }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [geoJson, setGeoJson] = useState<GeoJsonObject | null>(null);

  const contentUrl = useMemo(() => {
    const suffix = refreshKey > 0 ? `&refresh=${refreshKey}` : "";
    return `${getContentUrl(windowState.path)}${suffix}`;
  }, [refreshKey, windowState.path]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setIsLoading(true);
      setErrorMessage(null);
      setGeoJson(null);

      try {
        const response = await fetch(contentUrl);
        if (!response.ok) {
          throw new Error(await readResponseError(response));
        }

        const blob = await response.blob();
        const kmlText = await extractKmlText(blob, windowState.name);
        const parsed = toGeoJson(kmlText);

        if (!hasRenderableFeatures(parsed)) {
          throw new Error("Map data is empty.");
        }

        if (!cancelled) {
          setGeoJson(parsed);
        }
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(
            error instanceof Error ? error.message : "Failed to load KMZ map preview"
          );
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [contentUrl, windowState.name]);

  const deferredGeoJson = useDeferredValue(geoJson);

  return (
    <div className="flex h-full w-full flex-col bg-background-neutral-00">
      <div className="flex items-center justify-between border-b border-border-01 px-2 py-1.5">
        <Text text03 className="truncate text-xs">
          {isLoading
            ? "Loading map preview..."
            : errorMessage
              ? errorMessage
              : "KMZ map preview"}
        </Text>
        <button
          type="button"
          className="rounded-08 border border-border-01 px-2 py-0.5 text-xs hover:bg-background-neutral-01"
          onClick={() => setRefreshKey((value) => value + 1)}
          title="Reload preview"
        >
          Reload
        </button>
      </div>

      <div className="h-[calc(100%-2.25rem)] w-full bg-background-neutral-02">
        {isLoading ? (
          <div className="flex h-full w-full items-center justify-center px-4 text-center">
            <Text text03>Loading map preview...</Text>
          </div>
        ) : errorMessage || !deferredGeoJson ? (
          <div className="flex h-full w-full items-center justify-center px-4 text-center">
            <Text text03>{errorMessage || "Map preview unavailable for this KMZ."}</Text>
          </div>
        ) : (
          <NeuralLabsKmzMap geoJson={deferredGeoJson} />
        )}
      </div>
    </div>
  );
}

function XlsxContent({ windowState }: { windowState: PreviewWindowState }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<XlsxPreviewData | null>(null);
  const [activeSheetIndex, setActiveSheetIndex] = useState(0);

  const contentUrl = useMemo(() => {
    const suffix = refreshKey > 0 ? `&refresh=${refreshKey}` : "";
    return `${getContentUrl(windowState.path)}${suffix}`;
  }, [refreshKey, windowState.path]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setIsLoading(true);
      setErrorMessage(null);
      setPreviewData(null);

      try {
        const response = await fetch(contentUrl);
        if (!response.ok) {
          throw new Error(await readResponseError(response));
        }

        const blob = await response.blob();
        const parsed = await extractXlsxPreviewData(blob);
        if (!cancelled) {
          setPreviewData(parsed);
          setActiveSheetIndex(0);
        }
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(
            error instanceof Error ? error.message : "Unable to load spreadsheet preview"
          );
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [contentUrl]);

  const activeSheet =
    previewData && previewData.sheets.length > 0
      ? previewData.sheets[Math.min(activeSheetIndex, previewData.sheets.length - 1)]!
      : null;

  return (
    <div className="flex h-full w-full flex-col bg-background-neutral-00">
      <div className="flex items-center justify-between border-b border-border-01 px-2 py-1.5">
        <Text text03 className="truncate text-xs">
          {isLoading
            ? "Loading spreadsheet preview..."
            : errorMessage
              ? errorMessage
              : activeSheet
                ? `${previewData?.sheets.length ?? 0} sheet(s) · ${activeSheet.rows.length} row(s)`
                : "Spreadsheet preview"}
        </Text>
        <button
          type="button"
          className="rounded-08 border border-border-01 px-2 py-0.5 text-xs hover:bg-background-neutral-01"
          onClick={() => setRefreshKey((value) => value + 1)}
          title="Reload preview"
        >
          Reload
        </button>
      </div>

      {previewData?.sheets.length ? (
        <div className="flex items-center gap-1 overflow-auto border-b border-border-01 px-2 py-1">
          {previewData.sheets.map((sheet, index) => (
            <button
              key={`${sheet.name}-${index}`}
              type="button"
              className={`shrink-0 rounded-08 border px-2 py-1 text-xs ${
                index === activeSheetIndex
                  ? "border-border-04 bg-background-tint-03 text-text-00"
                  : "border-border-01 bg-background-neutral-01 text-text-03 hover:bg-background-neutral-02"
              }`}
              onClick={() => setActiveSheetIndex(index)}
            >
              {sheet.name}
            </button>
          ))}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto bg-background-neutral-02">
        {isLoading ? (
          <div className="flex h-full w-full items-center justify-center px-4 text-center">
            <Text text03>Loading spreadsheet preview...</Text>
          </div>
        ) : errorMessage || !activeSheet ? (
          <div className="flex h-full w-full items-center justify-center px-4 text-center">
            <Text text03>{errorMessage || "Spreadsheet preview unavailable."}</Text>
          </div>
        ) : (
          <div className="min-w-max p-2">
            <table className="border-collapse text-xs">
              <thead>
                <tr>
                  <th className="sticky top-0 left-0 z-20 border border-border-01 bg-background-neutral-01 px-2 py-1 text-right text-text-03">
                    #
                  </th>
                  {Array.from({ length: activeSheet.columnCount }, (_, index) => (
                    <th
                      key={index}
                      className="sticky top-0 z-10 min-w-[7rem] border border-border-01 bg-background-neutral-01 px-2 py-1 text-left text-text-03"
                    >
                      {columnIndexToLabel(index)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {activeSheet.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    <td className="sticky left-0 z-10 border border-border-01 bg-background-neutral-01 px-2 py-1 text-right text-text-03">
                      {rowIndex + 1}
                    </td>
                    {Array.from({ length: activeSheet.columnCount }, (_, columnIndex) => (
                      <td
                        key={columnIndex}
                        className="max-w-[20rem] border border-border-01 bg-background-neutral-00 px-2 py-1 align-top font-mono text-text-00"
                        title={row[columnIndex] ?? ""}
                      >
                        <div className="line-clamp-3 whitespace-pre-wrap break-words">
                          {row[columnIndex] ?? ""}
                        </div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>

            {previewData &&
            (previewData.truncatedRows || previewData.truncatedColumns) ? (
              <div className="pt-2">
                <Text text03 className="text-xs">
                  Preview truncated to {MAX_XLSX_PREVIEW_ROWS} rows and {MAX_XLSX_PREVIEW_COLUMNS} columns.
                </Text>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function WindowContent({
  windowState,
  currentDirectory,
  onTextFileSaved,
}: {
  windowState: PreviewWindowState;
  currentDirectory: string;
  onTextFileSaved?: (path: string) => void;
}) {
  if (windowState.preview_kind === "app-text-editor") {
    return (
      <AppTextEditorContent
        currentDirectory={currentDirectory}
        onTextFileSaved={onTextFileSaved}
      />
    );
  }

  if (windowState.preview_kind === "text") {
    return (
      <TextEditorContent
        windowState={windowState}
        onTextFileSaved={onTextFileSaved}
      />
    );
  }

  if (windowState.preview_kind === "kmz") {
    return <KmzMapContent windowState={windowState} />;
  }

  if (windowState.preview_kind === "xlsx") {
    return <XlsxContent windowState={windowState} />;
  }

  const [refreshKey, setRefreshKey] = useState(0);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    setHasError(false);
  }, [refreshKey, windowState.path]);

  const contentUrl = useMemo(() => {
    const suffix = refreshKey > 0 ? `&refresh=${refreshKey}` : "";
    return `${getContentUrl(windowState.path)}${suffix}`;
  }, [refreshKey, windowState.path]);

  if (windowState.preview_kind === "image") {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background-neutral-02">
        {hasError ? (
          <div className="flex flex-col items-center gap-2 px-4 text-center">
            <Text text03>Unable to load this image preview.</Text>
            <button
              type="button"
              className="rounded-08 border border-border-01 px-3 py-1 text-sm hover:bg-background-neutral-01"
              onClick={() => setRefreshKey((value) => value + 1)}
            >
              Retry
            </button>
          </div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={contentUrl}
            alt={windowState.name}
            className="max-h-full max-w-full object-contain"
            onError={() => setHasError(true)}
          />
        )}
      </div>
    );
  }

  if (windowState.preview_kind === "pdf") {
    return hasError ? (
      <div className="flex h-full w-full items-center justify-center bg-background-neutral-02">
        <div className="flex flex-col items-center gap-2 px-4 text-center">
          <Text text03>Unable to load this PDF preview.</Text>
          <button
            type="button"
            className="rounded-08 border border-border-01 px-3 py-1 text-sm hover:bg-background-neutral-01"
            onClick={() => setRefreshKey((value) => value + 1)}
          >
            Retry
          </button>
        </div>
      </div>
    ) : (
      <iframe
        title={windowState.name}
        src={contentUrl}
        className="h-full w-full bg-background-neutral-02"
        onError={() => setHasError(true)}
      />
    );
  }

  return hasError ? (
    <div className="flex h-full w-full items-center justify-center bg-background-neutral-02">
      <div className="flex flex-col items-center gap-2 px-4 text-center">
        <Text text03>Unable to load this HTML preview.</Text>
        <button
          type="button"
          className="rounded-08 border border-border-01 px-3 py-1 text-sm hover:bg-background-neutral-01"
          onClick={() => setRefreshKey((value) => value + 1)}
        >
          Retry
        </button>
      </div>
    </div>
    ) : (
      <iframe
        title={windowState.name}
        src={contentUrl}
        sandbox="allow-same-origin allow-scripts"
        className="h-full w-full bg-white"
        onError={() => setHasError(true)}
      />
    );
}

function PreviewWindow({
  windowState,
  workspaceBounds,
  currentDirectory,
  onCloseWindow,
  onFocusWindow,
  onTextFileSaved,
  onUpdateWindow,
}: {
  windowState: PreviewWindowState;
  workspaceBounds: WorkspaceBounds;
  currentDirectory: string;
  onCloseWindow: (windowId: string) => void;
  onFocusWindow: (windowId: string) => void;
  onTextFileSaved?: (path: string) => void;
  onUpdateWindow: (
    windowId: string,
    update:
      | Partial<PreviewWindowState>
      | ((windowState: PreviewWindowState) => PreviewWindowState)
  ) => void;
}) {
  const interactionRef = useRef<InteractionState | null>(null);
  const displayWindow = useMemo(
    () => clampWindowToWorkspace(windowState, workspaceBounds),
    [windowState, workspaceBounds]
  );

  useEffect(() => {
    return () => {
      interactionRef.current = null;
    };
  }, []);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    onFocusWindow(windowState.id);
    interactionRef.current = {
      mode: "drag",
      pointerX: event.clientX,
      pointerY: event.clientY,
      windowState: displayWindow,
    };
  };

  const startResize =
    (direction: ResizeDirection) => (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      onFocusWindow(windowState.id);
      interactionRef.current = {
        mode: "resize",
        pointerX: event.clientX,
        pointerY: event.clientY,
        direction,
        windowState: displayWindow,
      };
    };

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const interaction = interactionRef.current;
      if (!interaction) {
        return;
      }

      const deltaX = event.clientX - interaction.pointerX;
      const deltaY = event.clientY - interaction.pointerY;

      if (interaction.mode === "drag") {
        onUpdateWindow(interaction.windowState.id, (existingWindow) => {
          const nextWindow = {
            ...existingWindow,
            x: interaction.windowState.x + deltaX,
            y: interaction.windowState.y + deltaY,
            snapped_zone: null,
          };
          return clampWindowToWorkspace(nextWindow, workspaceBounds);
        });
        return;
      }

      onUpdateWindow(interaction.windowState.id, (existingWindow) => {
        const source = {
          ...interaction.windowState,
          snapped_zone: null,
        };
        let nextX = source.x;
        let nextY = source.y;
        let nextWidth = source.width;
        let nextHeight = source.height;

        if (interaction.direction.includes("e")) {
          nextWidth = source.width + deltaX;
        }
        if (interaction.direction.includes("s")) {
          nextHeight = source.height + deltaY;
        }
        if (interaction.direction.includes("w")) {
          nextWidth = source.width - deltaX;
          nextX = source.x + deltaX;
        }
        if (interaction.direction.includes("n")) {
          nextHeight = source.height - deltaY;
          nextY = source.y + deltaY;
        }

        const maxWidth = Math.max(
          MIN_WINDOW_WIDTH,
          workspaceBounds.width - WINDOW_GAP * 2
        );
        const maxHeight = Math.max(
          MIN_WINDOW_HEIGHT,
          workspaceBounds.height - WINDOW_GAP * 2
        );
        const width = clamp(nextWidth, MIN_WINDOW_WIDTH, maxWidth);
        const height = clamp(nextHeight, MIN_WINDOW_HEIGHT, maxHeight);
        const widthDelta = width - nextWidth;
        const heightDelta = height - nextHeight;
        const adjustedX = interaction.direction.includes("w")
          ? nextX - widthDelta
          : nextX;
        const adjustedY = interaction.direction.includes("n")
          ? nextY - heightDelta
          : nextY;

        return clampWindowToWorkspace(
          {
            ...existingWindow,
            x: adjustedX,
            y: adjustedY,
            width,
            height,
            snapped_zone: null,
          },
          workspaceBounds
        );
      });
    };

    const handlePointerUp = () => {
      const interaction = interactionRef.current;
      if (!interaction) {
        return;
      }

      if (interaction.mode === "drag") {
        onUpdateWindow(interaction.windowState.id, (existingWindow) => {
          const snapZone = detectSnapZone(
            existingWindow.x,
            existingWindow.y,
            existingWindow.width,
            existingWindow.height,
            workspaceBounds
          );

          if (!snapZone) {
            return existingWindow;
          }

          return {
            ...existingWindow,
            snapped_zone: snapZone,
            ...getSnappedBounds(snapZone, workspaceBounds),
          };
        });
      }

      interactionRef.current = null;
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [onUpdateWindow, workspaceBounds]);

  const resizeHandles: Array<{
    direction: ResizeDirection;
    className: string;
  }> = [
    { direction: "n", className: "left-3 right-3 top-0 h-2 cursor-n-resize" },
    { direction: "ne", className: "right-0 top-0 h-3 w-3 cursor-ne-resize" },
    { direction: "e", className: "bottom-3 right-0 top-3 w-2 cursor-e-resize" },
    { direction: "se", className: "bottom-0 right-0 h-3 w-3 cursor-se-resize" },
    { direction: "s", className: "bottom-0 left-3 right-3 h-2 cursor-s-resize" },
    { direction: "sw", className: "bottom-0 left-0 h-3 w-3 cursor-sw-resize" },
    { direction: "w", className: "bottom-3 left-0 top-3 w-2 cursor-w-resize" },
    { direction: "nw", className: "left-0 top-0 h-3 w-3 cursor-nw-resize" },
  ];
  const previewLabel =
    displayWindow.preview_kind === "image"
      ? "Image Preview"
      : displayWindow.preview_kind === "app-text-editor"
        ? "Neural App"
      : displayWindow.preview_kind === "pdf"
        ? "PDF Preview"
      : displayWindow.preview_kind === "kmz"
        ? "KMZ Map Preview"
        : displayWindow.preview_kind === "xlsx"
          ? "Spreadsheet Preview"
        : displayWindow.preview_kind === "html"
        ? "HTML Preview"
        : "Text Editor";

  return (
    <div
      className="absolute overflow-hidden rounded-16 border border-border-04 bg-background-neutral-00 shadow-2xl"
      style={{
        left: displayWindow.x,
        top: displayWindow.y,
        width: displayWindow.width,
        height: displayWindow.height,
        zIndex: displayWindow.z_index,
      }}
      onMouseDown={() => onFocusWindow(windowState.id)}
    >
      <div
        className="grid h-11 cursor-move grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border-01 bg-background-neutral-01 px-3"
        onPointerDown={handlePointerDown}
      >
        <div className="min-w-0 flex items-center gap-2 overflow-hidden">
          {displayWindow.preview_kind === "image" ? (
            <SvgImage className="h-4 w-4 shrink-0 stroke-text-03" />
          ) : (
            <SvgFileText className="h-4 w-4 shrink-0 stroke-text-03" />
          )}
          <div className="min-w-0 overflow-hidden">
            <Text className="truncate" title={displayWindow.name}>
              {displayWindow.name}
            </Text>
            <Text text03 className="truncate text-xs">
              {previewLabel}
            </Text>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 rounded-full border border-border-01 bg-background-neutral-00/95 px-1 py-1 shadow-sm">
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded-full border border-border-01 bg-background-neutral-00 text-text-03 hover:bg-background-neutral-02 disabled:cursor-not-allowed disabled:opacity-45"
            onClick={() => onUpdateWindow(windowState.id, { snapped_zone: null })}
            title="Unsnap"
            disabled={!displayWindow.snapped_zone}
          >
            <SvgRefreshCw className="h-4 w-4 stroke-text-03" />
          </button>
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded-full border border-border-01 bg-background-neutral-00 text-text-03 hover:bg-background-neutral-02"
            onClick={() => onCloseWindow(windowState.id)}
            title="Close preview"
          >
            <SvgX className="h-4 w-4 stroke-text-03" />
          </button>
        </div>
      </div>

      <div className="h-[calc(100%-2.75rem)] w-full">
        <WindowContent
          windowState={displayWindow}
          currentDirectory={currentDirectory}
          onTextFileSaved={onTextFileSaved}
        />
      </div>

      {resizeHandles.map((handle) => (
        <div
          key={handle.direction}
          className={`absolute ${handle.className}`}
          onPointerDown={startResize(handle.direction)}
        />
      ))}
    </div>
  );
}

export default function NeuralLabsPreviewWindows({
  windows,
  workspaceBounds,
  currentDirectory,
  onCloseWindow,
  onFocusWindow,
  onTextFileSaved,
  onUpdateWindow,
}: NeuralLabsPreviewWindowsProps) {
  return (
    <>
      {windows.map((windowState) => (
        <PreviewWindow
          key={windowState.id}
          windowState={windowState}
          workspaceBounds={workspaceBounds}
          currentDirectory={currentDirectory}
          onCloseWindow={onCloseWindow}
          onFocusWindow={onFocusWindow}
          onTextFileSaved={onTextFileSaved}
          onUpdateWindow={onUpdateWindow}
        />
      ))}
    </>
  );
}
