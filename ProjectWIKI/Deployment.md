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
  - legacy tree navigator with context actions and drag/drop move
  - `/neural-labs` now opens directly into the desktop Neural Labs experience; the route-level legacy UI switch and return link were removed
  - desktop layout replaces fixed sidebars with a pill taskbar using icon launchers plus windowed `File Explorer`, `Terminal`, `Text Editor`, `Neura`, and `Desktop Settings` apps
  - desktop windows now use the full workspace height under the pinned header overlay, and that header renders behind the window stack so maximized and snapped windows can extend into the top strip without header chrome sitting above them
  - the bottom taskbar now uses theme-aware glass/background contrast and icon colors so light mode stays legible even when light windows are maximized behind it
  - desktop `File Explorer` now uses a Finder-style hybrid explorer instead of the legacy tree: sidebar locations, breadcrumb path navigation, per-window history/state, icon/list views, and drag/drop move or OS-file upload
  - desktop `Terminal` now uses a dedicated Windows Terminal-style app surface rather than the legacy terminal panel: independent terminal windows, top tabs, right-click tab actions, drag-reorder, move-tab-to-new-window, and in-window split controls
  - desktop `Text Editor` is now a dedicated Monaco-based app window instead of the former preview-window editor: per-window document tabs, open-files sidebar, command menu, manual save/save-as, and dirty-state tracking
  - desktop `Text Editor` now keeps its internal surfaces theme-consistent in both light and dark mode instead of mixing bright and dark panels within the same window
  - desktop `Neura` is now a dedicated Neural Labs chat app with a conversation sidebar, streaming replies, and taskbar `New Window` support; it is separate from the main Onyx assistant UI
  - Neura now uses a modern pill-style composer with inline image uploads for Sonnet vision instead of a text-only chat bar
  - a new Neura window now auto-creates its first conversation and focuses the composer once the workspace has no existing Neura chats
  - desktop explorer and terminal visuals now follow the app light/dark theme, including explicit theme-safe file/folder icon colors and xterm foreground/background switching
  - taskbar icons expose app names on hover through the same themed Neural Labs tooltip treatment
  - taskbar left click restores minimized windows or focuses the front-most running app instance; right click exposes `New Window` for multi-window desktop apps including `Neura`
  - split terminal tabs/panes
  - Terminal Navigator shows a single terminal as `Terminal 1` without a group wrapper; group cards only render when a tab contains multiple panes
  - file action icons expose hover helper text for create/upload/refresh
  - Neural Labs hover helper text now uses the themed white tooltip only; native browser duplicate tooltips are removed and tooltip positioning is clamped within the viewport above floating windows
  - terminal/group deletion is handled from the Terminal Navigator with trash actions rather than top-bar close controls; standalone terminal and group delete actions are red while in-group terminal delete actions stay neutral
  - desktop settings now default the desktop shell to `Sunset Grid`, keep preset selection persisted in browser storage, and allow uploading a custom background image into the user Neural Labs workspace at `~/.neural-labs/backgrounds/`
  - desktop app windows support macOS-style close/minimize/maximize controls, double-click title-bar maximize/restore, edge snap zones, and minimize-to-taskbar behavior
  - text files such as `.txt`, `.json`, `.md`, `.py`, and similar now open into the focused desktop editor window as tabs instead of a separate text preview mode
  - floating preview windows with snap/resize remain for image, PDF, HTML, KMZ, and XLSX files; text editing is handled by the desktop editor app
  - preview windows now use the same compact desktop window chrome as app windows, including matching macOS-style controls and double-click maximize/restore behavior
  - desktop app windows share focus / z-index behavior with existing preview windows so app windows and file previews layer together cleanly
  - HTML previews use a path-based `/api/neural-labs/files/content/<path>` route so relative assets load from the previewed workspace folder
  - HTML preview sandbox keeps scripts enabled but drops `allow-same-origin` to avoid the browser escape warning on generated sites
  - the web app `Permissions-Policy` header is restricted to currently supported directives so Chromium no longer logs unsupported-feature warnings
  - refresh/focus restores terminal layout by reconciling browser-saved tabs with live backend terminal IDs to reduce stale or ghost panes after reload
  - KMZ preview uses a client-only Leaflet bundle to avoid server-side `window is not defined` crashes on the Neural Labs page
- websocket terminal stream using dual-token auth (`token` + `terminal_token`) to keep browser WS auth and terminal session binding aligned
- managed shell startup files (`~/.bash_profile`, `~/.bashrc`) with Neural Labs banner
- Neura workspace-local persistence:
  - conversation history is stored in the user Neural Labs home at `~/.neural-labs/neura/neura.db`
  - image uploads for Neura vision chats are stored in the same workspace at `~/.neural-labs/neura/uploads/`
  - Neura traffic stays on the dedicated `/api/neural-labs/neura/*` endpoints and does not write into Onyx chat-session/message tables
- backend image now installs terminal CLIs for Neural Labs when `ENABLE_NEURAL_LABS=true`:
  - `claude` via Anthropic native installer (`curl -fsSL https://claude.ai/install.sh | bash`)
  - `/etc/profile.d` restores `/root/.local/bin` and `/root/.opencode/bin` for login shells so `bash -lc 'claude ...'` still works after `/etc/profile` rewrites `PATH`
- Neural Labs shell sessions inject provider credentials/config:
  - preferred Claude Code path is Microsoft Foundry when the configured `azure` provider points at a Foundry Claude endpoint:
    - `CLAUDE_CODE_USE_FOUNDRY=1`
    - `ANTHROPIC_FOUNDRY_BASE_URL=https://{resource}.services.ai.azure.com/anthropic`
    - optional: `ANTHROPIC_FOUNDRY_API_KEY` from the Azure provider API key
    - pinned defaults:
      - `ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-4-6`
      - `ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-7`
      - `ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-4-5`
  - otherwise Claude Code falls back to AWS Bedrock via IAM role:
    - `CLAUDE_CODE_USE_BEDROCK=1`
    - `AWS_REGION=us-east-1` unless the configured Bedrock provider overrides it
    - `ANTHROPIC_DEFAULT_SONNET_MODEL=us.anthropic.claude-sonnet-4-6`
    - `ANTHROPIC_DEFAULT_OPUS_MODEL=global.anthropic.claude-opus-4-6-v1`
    - `ANTHROPIC_DEFAULT_HAIKU_MODEL=us.anthropic.claude-haiku-4-5-20251001-v1:0`
  - direct Anthropic fallback remains supported via `ANTHROPIC_API_KEY` only when neither Foundry nor Bedrock is configured
- Neural Labs no longer provisions OpenAI/Codex credentials or config; the managed shell is Claude-only
- Build/Craft sessions now resolve Bedrock Claude only and pass the configured Bedrock region into the local `opencode` subprocess

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
  - the live `clauddemo` Bedrock provider is pinned to `global.anthropic.claude-opus-4-6-v1` for chat defaults and only exposes Opus 4.6 plus Haiku 4.5 in the app UI
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
