# chatVSP Local Wiki

This folder is the local copy of operational documentation for chatVSP.

## Start Here

- [Deployment](Deployment.md)
- [Architecture](Architecture.md)
- [AWS Architecture and Networking](AWS-Architecture-and-Networking.md)
- [Health Checks](Health-Checks.md)
- [Branding and Custom Images](Branding-and-Custom-Images.md)
- [Troubleshooting 502 and Voice WebSockets](Troubleshooting-502-and-Voice-WebSockets.md)
- [Voice Capabilities](Voice-Capabilities.md)

## Current Production Endpoints (2026-04-14)

- App: `https://chatvsp.vsp-app-aws-us-west-2.com`
- SSH: `ssh-chatvsp.vsp-app-aws-us-west-2.com:22`

## Important Rule

If you want ChatVSP custom UI/behavior, do not rely only on pulled `onyxdotapp/*` images. Build from this repository for `web_server` and backend services.

## Neural Labs Status

- Neural Labs now runs a WardGPT Codex-Labs parity implementation under Neural Labs route/branding.
- Current live scope includes:
  - `enable_neural_labs` on users
  - admin toggle support
  - gated `/neural-labs` route
  - compose/runtime flag `ENABLE_NEURAL_LABS`
  - per-user persistent workspace rooted under the shared `file-system` volume
  - backend workspace APIs with Codex-Labs parity compatibility routes:
    - warmup/session/status/list/create/close terminals
    - websocket + SSE terminal streams
    - file list/content/download/upload/create directory/rename/move/edit/delete
    - missing file or directory paths return `404` so stale browser tree state self-heals correctly
  - modular web UI with:
    - tree-based file navigator (expand/collapse, context menu, drag/drop move, hidden file toggle)
    - independently collapsible file navigator and terminal navigator with thin icon rails when collapsed
    - multi-terminal tabs with split panes, consistent terminal/pane terminology, and navigator grouping that mirrors split orientation
    - floating preview windows (snap/drag/resize) for text, image, PDF, HTML, KMZ, and XLSX
    - HTML preview iframe now allows scripts and same-origin access so generated graph outputs can render instead of falling back to a blank/non-interactive frame
    - terminal refresh/focus flow now reconciles saved layout against live backend sessions to reduce stale pane or ghost-terminal behavior after reload
    - KMZ/Leaflet preview is loaded client-only to avoid `window is not defined` SSR failures on `/neural-labs`
  - terminal websocket auth aligned for prod (`/api/neural-labs/terminal/ws?token=...&terminal_token=...`)
  - managed shell banner and login profile initialization
  - per-user Codex config bootstrap at `~/.codex/config.toml`
  - OpenAI Codex runtime config using custom provider ID `openai-custom` (to avoid overriding reserved built-in IDs)
  - API key sourced from Onyx provider settings and injected as `OPENAI_API_KEY`
  - fixed OpenAI endpoint in Codex config (`https://api.openai.com/v1`)
  - preinstalled terminal CLIs in Neural Labs backend image:
    - `codex` (`@openai/codex`)
    - `claude` (Anthropic native installer via `https://claude.ai/install.sh`)
    - image also restores CLI paths from `/etc/profile.d` so login shells still resolve `codex` and `claude`
  - shell env injection from configured providers:
    - `OPENAI_API_KEY` (required for `codex`)
    - `ANTHROPIC_API_KEY` (optional, enables `claude`)
- Important behavior:
  - Neural Labs no longer writes any MCP server entries into `~/.codex/config.toml`
  - this prevents legacy `onyx` / `wardgpt` MCP bootstrap leakage from imported Codex Labs examples
- Current deployment requirement:
  - `ENABLE_NEURAL_LABS=true` in `deployment/docker_compose/.env`
  - per-user access enabled from Admin Users
- Note:
  - infrastructure-level Codex/Craft compose wiring remains intentionally separate from this Neural Labs parity import.
