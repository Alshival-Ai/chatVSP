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

## SSH Path

- `ssh-chatvsp.vsp-app-aws-us-west-2.com` resolves to NLB
- NLB forwards TCP/22 to the same EC2 instance
