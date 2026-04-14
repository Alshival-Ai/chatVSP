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
- User flag: enable Neural Labs access for the target user from the Admin Users page
- Rebuild/restart the app services after code changes:

```bash
cd deployment/docker_compose
sudo docker compose -f docker-compose.prod.yml build api_server background web_server
sudo docker compose -f docker-compose.prod.yml up -d --no-deps api_server background web_server nginx
```

Current live scope is the first functional Neural Labs slice:

- gated `/neural-labs` access
- per-user persistent workspaces on the shared `file-system` volume
- backend APIs for warmup, list, read, upload, folder create, rename, move, text save, and delete
- browser UI for folder navigation plus text, image, PDF, and HTML previews
- terminal / PTY session management in the Neural Labs page
- split terminal controls in the UI (vertical and horizontal pane modes)
- websocket terminal stream using dual-token auth (`token` + `terminal_token`) to keep browser WS auth and terminal session binding aligned
- managed shell startup files (`~/.bash_profile`, `~/.bashrc`) with Neural Labs banner
- Codex bootstrap config written to `~/.codex/config.toml`
- OpenAI-only Codex provider bootstrap using Onyx LLM provider credentials
- fixed Codex OpenAI endpoint (`https://api.openai.com/v1`)

Operational note:

- after recreating `api_server`, restart `nginx` as well so it refreshes the upstream container IP:

```bash
cd deployment/docker_compose
sudo docker compose -f docker-compose.prod.yml restart nginx
```

Neural Labs intentionally does not pre-provision custom MCP servers or custom skills in chatVSP.


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
