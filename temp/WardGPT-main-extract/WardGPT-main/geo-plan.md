## KMZ/KML Accuracy Upgrade Plan

### Summary
Move from prompt-led geospatial behavior to a deterministic KMZ/KML pipeline with explicit validation, geocoding quality controls, and verifiable output QA.

### Key Changes
- Add a backend geospatial processing module that:
  - Parses KML/KMZ into typed internal objects.
  - Validates coordinate order/range, geometry validity, and required KML structure.
  - Re-emits normalized KML and packages KMZ with deterministic archive structure.
- Add a geocoding abstraction layer:
  - Provider interface with confidence + source metadata.
  - Caching of resolved anchors.
  - Hard fallback states (`resolved`, `approximate`, `missing`) carried into output metadata.
- Add an “approximation engine” for inferred assets:
  - Explicit anchor-based transforms (offset, bearing, span length).
  - Planning-grade uncertainty radius per inferred point/line.
  - Deterministic placement order to avoid run-to-run drift.
- Add output QA report artifact per run:
  - Counts of exact vs inferred coordinates.
  - Validation warnings/errors.
  - Archive integrity check (`doc.kml` presence, referenced asset consistency).

### API / Interface Changes
- Introduce a structured geospatial result contract (internal first), e.g.:
  - `anchors[]` with `source`, `confidence`, `lat/lon`
  - `features[]` with `geometry`, `provenance` (`exact|inferred`)
  - `quality_report` with `warnings`, `errors`, `uncertainty_metrics`
- Add optional “strict mode” flag:
  - `strict=true` blocks output when critical validation fails.
  - `strict=false` returns planning-grade output with mandatory warnings.

### Test Plan
- Golden-file tests:
  - KMZ in → normalized KMZ out (byte-stable structure expectations where feasible).
- Validation tests:
  - Bad coordinate order, out-of-range values, malformed rings, missing anchors.
- Approximation tests:
  - Deterministic placement from the same anchors/map context.
  - Uncertainty tagging present on all inferred geometries.
- Integration tests:
  - With geocoder available and unavailable paths.
  - Ensure fallback messaging and output metadata are consistent.

### Assumptions / Defaults
- Default to `strict=false` for user productivity, but always emit `quality_report`.
- Preserve all original placemark/style data unless explicitly transformed.
- Treat any inferred geometry as planning-grade and surface that in both metadata and assistant response.
