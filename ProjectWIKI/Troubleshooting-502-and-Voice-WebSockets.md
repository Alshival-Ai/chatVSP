# Troubleshooting 502 and Voice WebSockets

## 502 at ALB

Common causes:

- nginx container crash loop
- API not ready
- ALB health check path misconfigured

### Known incident (2026-03-24)

- nginx used TLS template expecting local certbot files
- local cert files were missing because TLS is terminated at ALB/ACM
- nginx restarted repeatedly, ALB returned `502`

Fix:

- run nginx HTTP template mode on instance
- keep TLS at ALB
- set target group health check path to `/api/health`

## Voice WebSocket Failures

Checklist:

- `WEB_DOMAIN` exactly matches browser origin
- nginx forwards WebSocket headers for `/api/*`
- backend sees proper `X-Forwarded-*` headers

Expected failure signature when `WEB_DOMAIN` is wrong:

- origin mismatch in backend logs

## API Route Mismatch After Partial Rebuild (2026-03-24)

Symptoms:

- frontend calls returned:
  - `/api/voice/status` -> `404`
  - `/api/admin/llm/test` -> `422` (payload shape mismatch)
- browser also showed JS runtime errors from undefined config arrays

Root cause:

- `web_server` was rebuilt from local source, but `api_server`/`background` were still running an older `onyx-backend:latest` image.
- frontend/backend contracts drifted.

Fix:

1. Rebuild backend from local source:
   - `sudo docker compose -f docker-compose.prod.yml build api_server background`
2. Restart backend services:
   - `sudo docker compose -f docker-compose.prod.yml up -d --no-deps api_server background`
3. If nginx still returns `502` after backend is healthy, recreate nginx to refresh upstream container IPs:
   - `sudo docker compose -f docker-compose.prod.yml up -d --no-deps --force-recreate nginx`

## Startup Blocked by Alembic + OpenSearch Mapping (2026-03-24)

Observed errors:

- Alembic startup failure:
  - `KeyError: 'c7bf5721733e'` during merge revision `d4f1e7c2b9a0`
- OpenSearch startup retries:
  - `Mapper for [title] conflicts with existing mapper ... analyzer from [default] to [english]`

Applied recovery:

1. Patched migration merge file:
   - `backend/alembic/versions/d4f1e7c2b9a0_merge_alembic_heads_for_chat_backgrounds.py`
   - removed stale `c7bf5721733e` from `down_revision`.
2. Rebuilt and restarted backend containers.
3. Deleted conflicting OpenSearch index to allow mapping recreation:
   - `danswer_chunk_nomic_ai_nomic_embed_text_v1`
4. Verified API health:
   - `/api/health` -> `200`
   - `/api/voice/status` reachable (auth-gated `403` when unauthenticated, no longer `404`).
