# Deployment

## Current AWS Layout (2026-04-14)

- Route 53 public DNS
- ALB for app traffic (`80` -> redirect `443`, TLS terminated with ACM)
- NLB for SSH traffic (`22`)
- EC2 instance runs Docker Compose stack

App hostname:

- `chatvsp.vsp-app-aws-us-west-2.com` -> ALB

SSH hostname:

- `ssh-chatvsp.vsp-app-aws-us-west-2.com` -> NLB

## Compose Files

- `deployment/docker_compose/docker-compose.prod.yml`
- `deployment/docker_compose/.env`
- `deployment/docker_compose/.env.nginx`

## Required Environment Values

- `WEB_DOMAIN=https://chatvsp.vsp-app-aws-us-west-2.com`
- `AUTH_TYPE` as needed (`basic`, `oidc`, etc.)
- `USER_AUTH_SECRET` set for secure auth flows

## ALB Health Check Requirement

Target group health path must be:

- `/api/health`

Reason: root path returns redirects (`307`) and will fail strict `200` checks.

## Production Bring-Up

From `deployment/docker_compose`:

```bash
sudo docker compose -f docker-compose.prod.yml up -d
```

## Rebuild with Custom Source (ChatVSP Branding)

If the UI looks like stock Onyx, rebuild from local source instead of using only pulled images:

```bash
cd deployment/docker_compose
sudo docker compose -f docker-compose.prod.yml build web_server api_server background
sudo docker compose -f docker-compose.prod.yml up -d --no-deps web_server api_server background nginx
```

You can run the same flow with the helper script:

```bash
cd /home/ubuntu/chatVSP
./tools/bake.sh --profile prod
```

`tools/bake.sh --profile prod` now defaults to rebuilding and recreating:

- `web_server`
- `api_server`
- `background`

This default is intended to include Neural Labs frontend/backend code updates without forcing a full-stack rebuild.

For prod profiles, `tools/bake.sh` now runs the recreate step with `--no-deps` when specific services are targeted. This avoids dependency-healthcheck blocks (for example `relational_db` healthcheck gating) during app-only deploys.

## Neural Labs rollout

Neural Labs is behind both a global runtime flag and a per-user access flag.

- Global flag: set `ENABLE_NEURAL_LABS=true` in `deployment/docker_compose/.env`
- User flag: enable Neural Labs access for the target user from `Admin -> Users -> Edit user -> Neural Labs Access`
- Rebuild/restart the app services after code changes:

```bash
cd deployment/docker_compose
sudo docker compose -f docker-compose.prod.yml build api_server background web_server
sudo docker compose -f docker-compose.prod.yml up -d --no-deps api_server background web_server nginx
```

Current live scope is Neural Labs parity with WardGPT Codex Labs behavior (kept under Neural Labs route/branding):

- gated `/neural-labs` access
- per-user persistent workspaces on the shared `file-system` volume
- backend APIs for:
  - warmup/session/status/list/create/close terminals
  - websocket + SSE terminal streams
  - file list/content/download/upload/folder create/rename/move/text save/delete
- browser UI for:
  - tree navigator with context actions and drag/drop move
  - left sidebar splits into File Navigator + Neural Apps, with app icons available in the collapsed rail
  - split terminal tabs/panes
  - file action icons expose hover helper text for create/upload/refresh
  - terminal/group deletion is handled from the Terminal Navigator with trash actions rather than top-bar close controls
  - Neural Apps includes:
    - a Text Editor that saves pasted text into workspace files via the existing file-content API
    - a lightweight Browser for public `https://` URLs with a single address bar and no tabs
  - browser embedding is best-effort only; iframe-blocked sites fall back to an inline blocked state with an external-open action
  - floating preview windows with snap/resize for text, image, PDF, HTML, KMZ, and XLSX
  - HTML previews allow scripts and same-origin access so self-contained generated graph pages can render
  - refresh/focus restores terminal layout by reconciling browser-saved tabs with live backend terminal IDs to reduce stale or ghost panes after reload
  - KMZ preview uses a client-only Leaflet bundle to avoid server-side `window is not defined` crashes on the Neural Labs page
- websocket terminal stream using dual-token auth (`token` + `terminal_token`) to keep browser WS auth and terminal session binding aligned
- managed shell startup files (`~/.bash_profile`, `~/.bashrc`) with Neural Labs banner
- Codex bootstrap config written to `~/.codex/config.toml`
- OpenAI Codex provider bootstrap using Onyx LLM provider credentials
- Codex config uses custom provider ID `openai-custom` with OpenAI default base URL (`https://api.openai.com/v1`)
- fixed Codex OpenAI endpoint (`https://api.openai.com/v1`)
- backend image now installs terminal CLIs for Neural Labs when `ENABLE_NEURAL_LABS=true`:
  - `@openai/codex`
  - `claude` via Anthropic native installer (`curl -fsSL https://claude.ai/install.sh | bash`)
  - `/etc/profile.d` restores `/root/.local/bin` and `/root/.opencode/bin` for login shells so `bash -lc 'claude ...'` still works after `/etc/profile` rewrites `PATH`
- Neural Labs shell sessions inject keys from configured providers:
  - `OPENAI_API_KEY` from the OpenAI provider (required for Codex)
  - `ANTHROPIC_API_KEY` from the Anthropic provider (optional, enables Claude CLI auth)

Neural Labs intentionally does not write MCP server blocks into `~/.codex/config.toml`.
This avoids cross-app inheritance from imported WardGPT / Onyx examples and prevents stale
`onyx` / `wardgpt` MCP startup failures in provisioned user shells.

Operational note:

- after recreating `api_server`, restart `nginx` as well so it refreshes the upstream container IP:

```bash
cd deployment/docker_compose
sudo docker compose -f docker-compose.prod.yml restart nginx
```

Verification note:

- verify the rebuilt image from a login shell, not only with direct binary paths:

```bash
cd deployment/docker_compose
sudo docker compose -f docker-compose.prod.yml exec api_server bash -lc 'echo "$PATH"; which claude; claude --version'
```

- expected result:
  - `PATH` contains `/root/.local/bin`
  - `which claude` resolves to `/root/.local/bin/claude`
  - `claude --version` prints the installed version

Neural Labs parity currently focuses on application/backend behavior. Deployment-level service topology changes (compose/nginx/runtime restructuring) remain a separate rollout decision.


## Enterprise Feature Toggle (Applied 2026-03-24)

To force enterprise features visible in this self-hosted environment, set these in `deployment/docker_compose/.env`:

- `ENABLE_PAID_ENTERPRISE_EDITION_FEATURES=true`
- `LICENSE_ENFORCEMENT_ENABLED=false`
- `NEXT_PUBLIC_ENABLE_PAID_EE_FEATURES=true`

Then apply:

```bash
cd deployment/docker_compose
sudo docker compose -f docker-compose.prod.yml build web_server
sudo docker compose -f docker-compose.prod.yml up -d --no-deps api_server background web_server nginx
sudo docker compose -f docker-compose.prod.yml up -d --no-deps --force-recreate nginx
```

Verification:

- `https://chatvsp.vsp-app-aws-us-west-2.com/api/health` returns `200`
- API logs show `/enterprise-settings` returning `200`

## Note on TLS

TLS is terminated at ALB via ACM. Instance nginx should run HTTP template mode for upstream routing.

## Resource Monitoring During Rebuilds

Use these quick checks before and after rebuilds to reduce VM crash risk:

```bash
free -h
docker stats --no-stream
docker compose -p onyx -f deployment/docker_compose/docker-compose.prod.yml ps
```
