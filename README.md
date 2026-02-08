# ChatVSP

ChatVSP is a customized, client‑branded fork of the open‑source Onyx platform. It provides an AI chat experience with enterprise search, connectors, and admin tooling tailored for verticals like hospitals, hotels, and other service organizations.

## What’s in this repo

- `web/` — Next.js frontend (UI/UX, theming, branding)
- `backend/` — FastAPI backend, auth, connectors, indexing, workers
- `deployment/` — Docker compose configs and deployment assets
- `widget/` — embeddable widget
- `desktop/` — desktop app (if enabled)
- `extensions/` — browser extension support

## Quick Start (Docker)

1. Ensure Docker and Docker Compose are installed.
2. From the repo root, switch into the docker compose folder and start:

```bash
cd deployment/docker_compose
docker compose -f docker-compose.yml build
docker compose -f docker-compose.yml up -d
```

Open:

- Frontend: `http://localhost:3000` (also exposed on `http://localhost`)
- API: `http://localhost:8080`

If you need additional exposed ports for development, use the dev override:

```bash
cd deployment/docker_compose
docker compose -f docker-compose.yml -f docker-compose.dev.yml build
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
```

## Local Development

Frontend (Next.js):

```bash
cd web
npm install
npm run dev
```

Backend (FastAPI):

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn onyx.main:app --host 0.0.0.0 --port 8080
```

Note: In this repo we commonly run via Docker for parity with production. The frontend uses the backend via `http://localhost:3000/api/*` when running the full stack.

## Common Commands

Frontend:

```bash
cd web
npm run lint
```

Backend tests:

```bash
cd backend
python -m dotenv -f .vscode/.env run -- pytest backend/tests/unit
```

## Configuration

Docker compose reads `.env` in `deployment/docker_compose/` when present.

Key variables:

- `HOST_PORT` (default `3000`) — frontend
- `HOST_PORT_80` (default `80`) — frontend via port 80
- `NEXT_PUBLIC_*` — frontend build options

See `deployment/docker_compose/env.template` for the full list.

## Notes

- This is a client‑branded fork. UI text and branding should say **ChatVSP** unless it is a required upstream credit or license reference.
- Keep changes UI‑safe and avoid breaking internal identifiers or API contracts.

## License

See `LICENSE`.
