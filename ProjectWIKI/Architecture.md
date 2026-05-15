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
  - the default target is the bundled local app at `/neural-labs-app/desktop`
  - the launcher signs a short-lived trusted-login token for the current Onyx user
- Access controls:
  - existing Onyx auth and feature gates remain in place before redirect
  - global gate: `ENABLE_NEURAL_LABS=true`
  - per-user gate: `enable_neural_labs` toggle in Admin Users
- Runtime ownership:
  - desktop UX/runtime lives in the vendored `neural-labs/` app and `neural_labs` Compose service
  - nginx proxies `/neural-labs-app/*` to the local `neural_labs` service
  - workspace containers are created from the bundled `neural-labs-workspace` image

## SSH Path

- `ssh-chatvsp.vsp-app-aws-us-west-2.com` resolves to NLB
- NLB forwards TCP/22 to the same EC2 instance
