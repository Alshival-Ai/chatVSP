# Architecture

## Request Flow

1. Browser hits Route 53 hostname.
2. Route 53 aliases to ALB.
3. ALB terminates TLS with ACM and forwards HTTP to EC2.
4. EC2 nginx routes:
   - `/api/*` to `api_server`
   - `/` to `web_server`
5. `api_server` uses PostgreSQL, Redis, Vespa, OpenSearch, model servers.
6. `background` workers process async tasks.

## Main Services

- `web_server` (Next.js)
- `api_server` (FastAPI)
- `nginx` (in-instance reverse proxy)
- `relational_db` (PostgreSQL)
- `cache` (Redis)
- `index` (Vespa)
- `opensearch` (OpenSearch)
- `inference_model_server` / `indexing_model_server`
- `background` (Celery workers)

## Neural Labs Runtime Path

- Web route: `/neural-labs`
- UI presentation:
  - same route serves both the legacy workspace layout and the new desktop shell
  - frontend persists the selected mode in browser storage and falls back to legacy on smaller screens
- API prefix: `/api/neural-labs/*`
- Terminal websocket path returned by token API:
  - `/api/neural-labs/terminal/ws?token=<auth_token>&terminal_token=<terminal_ticket>`
- Per-user workspace root:
  - `${PERSISTENT_DOCUMENT_STORAGE_PATH}/${tenant_id}/neural-labs/${user_id}`
- File API status semantics:
  - missing files or directories now return `404`
  - invalid paths and traversal-style input return `400`
  - conflicting create / move / rename operations return `409`
- Frontend tree state recovery:
  - the Neural Labs file tree persists expanded and selected paths in browser storage
  - if a persisted directory no longer exists, the frontend clears that stale entry when the API returns `404`
- Frontend window model:
  - file preview/editor windows continue to use the persisted floating preview-window model
  - desktop-only app windows (`File Explorer`, `Terminal`, `Desktop Settings`) are client-side windows layered into the same workspace and focus ordering
  - desktop app windows track snapped, maximized, and minimized state on the client so taskbar restore/focus behavior does not require backend changes
  - desktop file explorer windows keep separate per-window navigation state (`current_path`, back/forward history, selection, and icon/list mode) while reusing the shared file API/cache layer
  - desktop presentation preferences such as the selected preset/custom background choice persist in browser storage on the client
  - uploaded custom desktop background images are stored in the user Neural Labs workspace under `~/.neural-labs/backgrounds/` and served back through the existing file-content API

## SSH Path

- `ssh-chatvsp.vsp-app-aws-us-west-2.com` resolves to NLB
- NLB forwards TCP/22 to the same EC2 instance
