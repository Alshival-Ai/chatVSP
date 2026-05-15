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
./tools/bake.sh --profile prod --down-first
```

`tools/bake.sh --profile prod --down-first` rebuilds and recreates:

- `web_server`
- `api_server`
- `background`

This default is intended to include Neural Labs frontend/backend code updates without forcing a full-stack rebuild.

For prod profiles, `tools/bake.sh` now runs the recreate step with `--no-deps` when specific services are targeted. This avoids dependency-healthcheck blocks (for example `relational_db` healthcheck gating) during app-only deploys.

## Neural Labs rollout

Neural Labs is behind both a global runtime flag and a per-user access flag.

- Global flag: set `ENABLE_NEURAL_LABS=true` in `deployment/docker_compose/.env`
- User flag: enable Neural Labs access for the target user from `Admin -> Users -> Edit user -> Neural Labs Access`
- Launcher target defaults to the bundled local path: `NEURAL_LABS_DESKTOP_URL=/neural-labs-app/desktop`
- The trusted-login handoff secret defaults to `USER_AUTH_SECRET`; override with `NEURAL_LABS_AUTH_SHARED_SECRET` if needed
- Rebuild/restart the app services after code changes:

```bash
cd /home/ubuntu/chatVSP
./tools/bake.sh --down-first
```

- Runtime note:
  - `/neural-labs` remains the Onyx-authenticated launcher
  - `/neural-labs-app/*` is proxied by nginx to the bundled `neural_labs` service
  - direct unauthenticated `/neural-labs-app/desktop` requests redirect to `/neural-labs-app/login`; authenticated users should enter through `/neural-labs` so the trusted-login handoff sets the Neural Labs session cookie
  - the vendored workspace image installs Claude Code and receives Claude/Bedrock env
  - `./tools/bake.sh --profile prod --down-first` is also supported for the production compose file

## Dependency Vulnerability Investigation (April 21, 2026)

Snapshot from local audits performed against tracked manifests:

- `web/package-lock.json`:
  - `npm audit --json`: `critical=1 high=6 moderate=4 total=11`
  - `npm audit --omit=dev --json`: `high=4 moderate=4 total=8`
- `widget/package-lock.json`:
  - full audit: `high=2 moderate=1 total=3`
  - runtime-only: `moderate=1 total=1`
- `examples/widget/package-lock.json`:
  - full audit: `high=3 moderate=2 total=5`
  - runtime-only: `high=1 total=1`
- `backend/onyx/server/features/build/sandbox/kubernetes/docker/templates/outputs/web/package-lock.json`:
  - full audit: `high=5 moderate=3 total=8`
- `desktop/package-lock.json`: `total=0`

Python requirement graph (`pip-audit`):

- `backend/requirements/default.txt`: `38 vulnerabilities in 17 packages`
- `backend/requirements/dev.txt`: `22 vulnerabilities in 10 packages`
- `backend/requirements/ee.txt`: `18 vulnerabilities in 6 packages`
- `backend/requirements/model_server.txt`: `20 vulnerabilities in 8 packages`
- `backend/requirements/combined.txt`: `40 vulnerabilities in 19 packages`
  - highest-count packages: `aiohttp` (10), `pypdf` (6), `litellm` (3), `nltk` (3)

Important repository-level finding:

- The branch tracks a large `temp/` tree (`~4,972` files) containing additional manifests.
- Tracked dependency manifests under `temp/`: `17`.
- Some are exact duplicates of active manifests; others are older and carry higher vulnerability counts.
  - example: `temp/.../onyx-main/backend/requirements/default.txt` shows `48 vulnerabilities in 21 packages`
  - example: `temp/.../onyx-main/backend/requirements/combined.txt` shows `50 vulnerabilities in 23 packages`

Interpretation:

- The reported GitHub total (`458`) is materially inflated by tracked `temp/` manifests in addition to real vulnerabilities in active backend Python and web dependency graphs.
- Production-facing JS runtime risk in active apps is comparatively small (single digits per app), while backend Python manifests are the largest active risk concentration.

Recommended remediation order:

1. Remove tracked `temp/` extracted project trees from the default branch and add an explicit `.gitignore` rule for those paths.
2. Patch active runtime JS dependencies first:
   - `next` (DoS advisory; upgrade to patched 16.2.x),
   - `lodash`/`lodash-es`,
   - `dompurify`/`monaco-editor` path.
3. Patch backend Python high-volume packages in `backend/requirements/*.txt` and regenerate lock artifacts:
   - prioritize `aiohttp`, `pypdf`, `litellm`, `nltk`, `cryptography`.
4. Re-run dependency scans after each batch to validate alert reduction and avoid introducing incompatible transitive upgrades.
- Build/Craft sessions now resolve Bedrock models only and pass the configured Bedrock region into the local `opencode` subprocess

Bedrock rollout notes:

- preferred admin/provider setup for Claude is `Bedrock` with `IAM` auth and region `us-east-1`
- runtime Claude defaults now prefer a configured Bedrock provider over direct Anthropic for chat defaults
- the EC2/runtime role must include at least:
  - `bedrock:ListFoundationModels`
    - required for the admin Bedrock "available models" endpoint and provider setup validation
  - `bedrock:InvokeModel`
  - `bedrock:InvokeModelWithResponseStream`
  - `bedrock:ListInferenceProfiles`
  - `bedrock:GetInferenceProfile`
- for Bedrock `us.anthropic.*` inference profiles, allow invoke access on the routed foundation-model ARNs across the profile's destination regions
  - example: `us.anthropic.claude-sonnet-4-6` can route to `us-east-1`, `us-east-2`, and `us-west-2`
- current account status:
  - `global.anthropic.claude-opus-4-6-v1` invokes successfully from the runtime role
  - `global.anthropic.claude-opus-4-7` and `us.anthropic.claude-opus-4-7` currently fail with AWS Marketplace entitlement errors
  - the live `clauddemo` Bedrock provider is pinned to `global.anthropic.claude-opus-4-6-v1` for chat defaults and currently exposes Opus 4.6, Haiku 4.5, and `openai.gpt-oss-safeguard-20b` in the app UI
  - Bedrock Meta Llama models currently reject tool use in streaming chat (`ConverseStream`) with:
    - `"This model doesn't support tool use in streaming mode."`
  - provisioned `llamademo` as a separate Bedrock provider path with `us.meta.llama4-maverick-17b-instruct-v1:0` visible
    - chat runtime forces no-tools mode for Bedrock Llama models to avoid the streaming tool-use failure path
- Bedrock Claude model access must be enabled in the AWS account before rollout

Neural Labs also persists managed shell env into `~/.neural_labs_env` and sources it from
`~/.bashrc`. Existing terminal sessions are recreated when the managed env changes so Claude
provider/model pins do not remain stale across relaunches.

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

Neural Labs deployment topology now includes the bundled `neural_labs` service, the
`neural_labs_workspace` image, and nginx routing for `/neural-labs-app/*`.

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

## Legacy Embedded Neural Labs: Neura Crash + Monaco CSP Fix (Applied 2026-04-21)

This historical note applies to the old embedded `web/src/app/neural-labs` desktop
implementation. The active desktop runtime is now the vendored `neural-labs/` app
served at `/neural-labs-app/*`; `/neural-labs` is only the Onyx-authenticated launcher.

Symptoms observed in browser console:

- `Application error: a client-side exception has occurred`
- CSP blocks against Monaco CDN stylesheet:
  - `https://cdn.jsdelivr.net/npm/monaco-editor@.../editor.main.css`
- CSP blocks against `data:font/ttf;base64,...`
- Runtime crash in Neura render path:
  - `TypeError: Cannot read properties of undefined (reading 'length')`

Root causes:

1. Monaco loader defaulted to CDN assets in the browser when not explicitly configured.
2. Neura message render path assumed `message.attachments` was always present, but some payloads can omit it.

Applied fix in `web/src/app/neural-labs`:

- `NeuralLabsDesktopTextEditor.tsx`
  - Configure `@monaco-editor/react` loader to use local bundled `monaco-editor`:
    - `loader.config({ monaco: monacoEditor })`
  - This prevents jsDelivr stylesheet fetches and aligns with strict CSP (`style-src 'self'`).
- `page.tsx`
  - Normalize Neura message payloads so missing fields do not crash UI.
  - Ensure `attachments` defaults to `[]` and `content` defaults to `""`.
- `NeuralLabsDesktopNeura.tsx`
  - Defensive handling for potentially missing arrays/maps in window state.
  - Render uses safe attachment arrays instead of direct `message.attachments.length`.

Validation run:

```bash
cd web
npm run types:check
npm run build
```

Both commands complete successfully after the fix.
