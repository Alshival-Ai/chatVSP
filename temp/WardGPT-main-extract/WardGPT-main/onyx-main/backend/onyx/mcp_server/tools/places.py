"""Google Places tools for MCP server."""

from __future__ import annotations

import os
from typing import Any
from urllib.parse import quote

import httpx

from onyx.mcp_server.api import mcp_server
from onyx.mcp_server.utils import get_http_client
from onyx.mcp_server.utils import require_access_token
from onyx.utils.logger import setup_logger

logger = setup_logger()

_GOOGLE_PLACES_BASE_URL = "https://places.googleapis.com/v1"
_DEFAULT_SEARCH_FIELD_MASK = ",".join(
    [
        "places.id",
        "places.displayName",
        "places.formattedAddress",
        "places.location",
        "places.types",
        "places.googleMapsUri",
    ]
)
_DEFAULT_PLACE_DETAIL_FIELD_MASK = ",".join(
    [
        "id",
        "displayName",
        "formattedAddress",
        "location",
        "types",
        "googleMapsUri",
    ]
)


def _google_api_key() -> str | None:
    key = os.environ.get("GOOGLE_API_KEY", "").strip()
    return key or None


def _build_headers(field_mask: str) -> dict[str, str] | None:
    api_key = _google_api_key()
    if not api_key:
        return None
    return {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": api_key,
        "X-Goog-FieldMask": field_mask,
    }


async def _google_places_post(
    endpoint: str,
    payload: dict[str, Any],
    field_mask: str,
) -> dict[str, Any]:
    headers = _build_headers(field_mask)
    if not headers:
        return {
            "error": (
                "GOOGLE_API_KEY is not configured on the MCP server. "
                "Set GOOGLE_API_KEY in the server environment."
            ),
        }

    try:
        response = await get_http_client().post(
            f"{_GOOGLE_PLACES_BASE_URL}{endpoint}",
            headers=headers,
            json=payload,
            timeout=30.0,
        )
        response.raise_for_status()
        return response.json()
    except httpx.HTTPStatusError as e:
        detail: Any = None
        try:
            detail = e.response.json()
        except Exception:
            detail = e.response.text
        logger.error("Google Places request failed: %s", detail)
        return {"error": "Google Places request failed", "details": detail}
    except httpx.RequestError as e:
        logger.error("Google Places network request failed: %s", e)
        return {"error": f"Google Places network request failed: {e}"}


def _normalize_place(place: dict[str, Any]) -> dict[str, Any]:
    location = place.get("location") or {}
    return {
        "id": place.get("id"),
        "name": (place.get("displayName") or {}).get("text"),
        "formatted_address": place.get("formattedAddress"),
        "latitude": location.get("latitude"),
        "longitude": location.get("longitude"),
        "types": place.get("types", []),
        "google_maps_uri": place.get("googleMapsUri"),
    }


@mcp_server.tool()
async def google_places_search_text(
    query: str,
    limit: int = 5,
    language_code: str | None = None,
    region_code: str | None = None,
    location_bias_latitude: float | None = None,
    location_bias_longitude: float | None = None,
    location_bias_radius_meters: float | None = None,
) -> dict[str, Any]:
    """
    Search places using Google Places Text Search and return candidate places with coordinates.

    Use this for geocoding-like lookups when generating KMZ/KML where you need reliable
    place candidates and lat/lng coordinates.
    """
    require_access_token()

    max_result_count = max(1, min(limit, 20))
    payload: dict[str, Any] = {"textQuery": query, "maxResultCount": max_result_count}

    if language_code:
        payload["languageCode"] = language_code
    if region_code:
        payload["regionCode"] = region_code

    has_bias_center = (
        location_bias_latitude is not None and location_bias_longitude is not None
    )
    if has_bias_center:
        payload["locationBias"] = {
            "circle": {
                "center": {
                    "latitude": location_bias_latitude,
                    "longitude": location_bias_longitude,
                },
                "radius": location_bias_radius_meters or 5000.0,
            }
        }

    result = await _google_places_post(
        endpoint="/places:searchText",
        payload=payload,
        field_mask=_DEFAULT_SEARCH_FIELD_MASK,
    )
    if result.get("error"):
        return {"query": query, "places": [], "total_results": 0, **result}

    places = [_normalize_place(place) for place in result.get("places", [])]
    return {
        "query": query,
        "total_results": len(places),
        "places": places,
    }


@mcp_server.tool()
async def google_places_geocode_address(
    address: str,
    region_code: str | None = None,
) -> dict[str, Any]:
    """
    Resolve a street address or site name to a best coordinate using Google Places.

    Returns the top candidate location plus alternative candidates.
    """
    require_access_token()

    result = await google_places_search_text(
        query=address,
        limit=5,
        region_code=region_code,
    )
    if result.get("error"):
        return {"address": address, "best_match": None, "alternatives": [], **result}

    places = result.get("places", [])
    best_match = places[0] if places else None
    return {
        "address": address,
        "best_match": best_match,
        "alternatives": places[1:] if len(places) > 1 else [],
        "total_results": result.get("total_results", 0),
    }


@mcp_server.tool()
async def google_places_get_place_details(
    place_id: str,
    language_code: str | None = None,
) -> dict[str, Any]:
    """
    Retrieve details for a Google Place ID, including canonical coordinates and address.

    Use this after text search when you need to confirm a specific place candidate.
    """
    require_access_token()

    headers = _build_headers(_DEFAULT_PLACE_DETAIL_FIELD_MASK)
    if not headers:
        return {
            "error": (
                "GOOGLE_API_KEY is not configured on the MCP server. "
                "Set GOOGLE_API_KEY in the server environment."
            ),
            "place": None,
        }

    params: dict[str, str] = {}
    if language_code:
        params["languageCode"] = language_code

    try:
        response = await get_http_client().get(
            f"{_GOOGLE_PLACES_BASE_URL}/places/{quote(place_id, safe='')}",
            headers=headers,
            params=params or None,
            timeout=30.0,
        )
        response.raise_for_status()
        place = response.json()
        return {"place": _normalize_place(place)}
    except httpx.HTTPStatusError as e:
        detail: Any = None
        try:
            detail = e.response.json()
        except Exception:
            detail = e.response.text
        logger.error("Google Place details request failed: %s", detail)
        return {"error": "Google Place details request failed", "details": detail}
    except httpx.RequestError as e:
        logger.error("Google Place details network request failed: %s", e)
        return {"error": f"Google Place details network request failed: {e}"}


@mcp_server.tool()
async def google_places_search_nearby(
    latitude: float,
    longitude: float,
    radius_meters: float = 200.0,
    limit: int = 10,
    included_types: list[str] | None = None,
    language_code: str | None = None,
    region_code: str | None = None,
) -> dict[str, Any]:
    """
    Find nearby places around a coordinate with an optional type filter.

    Useful for validating map anchors, nearby landmarks, and map context around inferred
    KMZ/KML assets.
    """
    require_access_token()

    max_result_count = max(1, min(limit, 20))
    payload: dict[str, Any] = {
        "maxResultCount": max_result_count,
        "locationRestriction": {
            "circle": {
                "center": {"latitude": latitude, "longitude": longitude},
                "radius": max(1.0, radius_meters),
            }
        },
    }
    if included_types:
        payload["includedTypes"] = included_types
    if language_code:
        payload["languageCode"] = language_code
    if region_code:
        payload["regionCode"] = region_code

    result = await _google_places_post(
        endpoint="/places:searchNearby",
        payload=payload,
        field_mask=_DEFAULT_SEARCH_FIELD_MASK,
    )
    if result.get("error"):
        return {
            "center": {"latitude": latitude, "longitude": longitude},
            "places": [],
            "total_results": 0,
            **result,
        }

    places = [_normalize_place(place) for place in result.get("places", [])]
    return {
        "center": {"latitude": latitude, "longitude": longitude},
        "radius_meters": max(1.0, radius_meters),
        "total_results": len(places),
        "places": places,
    }
