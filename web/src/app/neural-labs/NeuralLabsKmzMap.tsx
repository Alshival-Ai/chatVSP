"use client";

import { useMemo } from "react";
import L from "leaflet";
import { GeoJSON as LeafletGeoJSONLayer, MapContainer, TileLayer } from "react-leaflet";
import type { GeoJsonObject } from "geojson";
import type { LatLng } from "leaflet";

export default function NeuralLabsKmzMap({
  geoJson,
}: {
  geoJson: GeoJsonObject;
}) {
  const bounds = useMemo(() => {
    const calculated = L.geoJSON(geoJson).getBounds();
    return calculated.isValid() ? calculated : null;
  }, [geoJson]);

  if (!bounds) {
    return null;
  }

  return (
    <MapContainer className="h-full w-full" bounds={bounds} scrollWheelZoom={false}>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <LeafletGeoJSONLayer
        data={geoJson}
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
  );
}
