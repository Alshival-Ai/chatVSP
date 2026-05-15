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
- Routing behavior:
  - `/neural-labs` now acts as an authenticated launcher route in `web_server`
  - if `NEURAL_LABS_DESKTOP_URL` is unset/invalid, the launcher falls back to `/app`
  - if `NEURAL_LABS_DESKTOP_URL` is a bare origin/path root, launcher appends `/desktop`
- Access controls:
  - existing Onyx auth and feature gates remain in place before redirect
  - global gate: `ENABLE_NEURAL_LABS=true`
  - per-user gate: `enable_neural_labs` toggle in Admin Users
- Runtime ownership:
  - desktop UX/runtime now lives in the external Neural Labs container/repo target
  - legacy embedded `/api/neural-labs/*` details in this wiki are stale unless re-enabled in code

## SSH Path

- `ssh-chatvsp.vsp-app-aws-us-west-2.com` resolves to NLB
- NLB forwards TCP/22 to the same EC2 instance
