"use client";

import { useEffect, useMemo, useState } from "react";
import JSZip from "jszip";
import L from "leaflet";
import { kml as kmlToGeoJson } from "@tmcw/togeojson";
import { GeoJSON as LeafletGeoJSONLayer, MapContainer, TileLayer } from "react-leaflet";
import type { GeoJsonObject } from "geojson";
import type { LatLng } from "leaflet";

interface KmzMapPreviewProps {
  fileId: string;
  fileName: string;
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

  return await kmlEntry.async("text");
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
  const candidate = geoJson as any;
  if (candidate.type === "FeatureCollection") {
    return Array.isArray(candidate.features) && candidate.features.length > 0;
  }
  if (candidate.type === "Feature") {
    return Boolean(candidate.geometry);
  }
  return true;
}

export default function KmzMapPreview({ fileId, fileName }: KmzMapPreviewProps) {
  const [geoJson, setGeoJson] = useState<GeoJsonObject | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setIsLoading(true);
      setError(null);
      setGeoJson(null);

      try {
        const response = await fetch(`/api/chat/file/${encodeURIComponent(fileId)}`);
        if (!response.ok) {
          throw new Error(`Failed to fetch KMZ file (${response.status}).`);
        }

        const blob = await response.blob();
        const kmlText = await extractKmlText(blob, fileName);
        const parsed = toGeoJson(kmlText);

        if (!hasRenderableFeatures(parsed)) {
          throw new Error("Map data is empty.");
        }

        if (!cancelled) {
          setGeoJson(parsed);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Failed to preview KMZ map."
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
  }, [fileId, fileName]);

  const bounds = useMemo(() => {
    if (!geoJson) {
      return null;
    }
    const calculated = L.geoJSON(geoJson as any).getBounds();
    return calculated.isValid() ? calculated : null;
  }, [geoJson]);

  if (isLoading) {
    return (
      <div className="rounded-xl border border-border-01 bg-background-tint-00 px-3 py-2 text-xs text-text-500">
        Loading map preview...
      </div>
    );
  }

  if (error || !geoJson || !bounds) {
    return (
      <div className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200">
        {error || "Map preview unavailable for this KMZ."}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border-01">
      <MapContainer
        className="h-[300px] w-full"
        bounds={bounds}
        scrollWheelZoom={false}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <LeafletGeoJSONLayer
          data={geoJson as any}
          pointToLayer={(_feature: unknown, latlng: LatLng) =>
            L.circleMarker(latlng, {
              radius: 5,
              color: "#0f766e",
              fillColor: "#22d3ee",
              fillOpacity: 0.75,
              weight: 1.5,
            })
          }
          style={() => ({
            color: "#0f766e",
            weight: 2,
            opacity: 0.95,
            fillColor: "#22d3ee",
            fillOpacity: 0.25,
          })}
        />
      </MapContainer>
    </div>
  );
}
