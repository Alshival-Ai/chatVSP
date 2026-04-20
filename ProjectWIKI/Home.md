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
    - left sidebar now stacks `File Navigator` over `Neural Apps`; when collapsed, Neural Apps surface as rail icons
    - multi-terminal tabs with split panes, consistent terminal/pane terminology, and navigator grouping that mirrors split orientation
    - Terminal Navigator now shows a lone terminal as `Terminal 1` without wrapping it in a group; grouped views only appear when a tab actually has multiple panes
    - file action icons now show explicit hover helper text for folder creation, upload, and refresh
    - Neural Labs action hover text now uses the themed white tooltip only; browser-native duplicate tooltips were removed and tooltip positioning is clamped within the viewport above floating windows
    - terminal and group deletion now lives in the Terminal Navigator via trash actions instead of top-bar close controls; standalone terminal and group delete icons are red, while in-group terminal delete icons remain neutral
    - Neural Apps currently includes a Text Editor that opens as its own floating app window over the workspace and can save pasted text directly into the workspace as a file; the sidebar launcher is now icon+name when expanded and icon-only when collapsed
    - text files such as `.txt`, `.json`, `.md`, `.py`, and similar now open in that floating editor window instead of a separate text preview mode
    - floating preview windows (snap/drag/resize) for image, PDF, HTML, KMZ, XLSX, and editor-backed text files
    - floating preview windows now include a maximize/restore control that preserves the prior bounds when returning from maximized state
    - HTML preview iframe now uses a path-based `/api/neural-labs/files/content/<path>` URL so relative `style.css`, `app.js`, and sibling asset requests resolve inside the selected workspace folder instead of collapsing to `/api/neural-labs/files/*`
    - HTML preview iframe keeps script execution enabled but no longer grants `allow-same-origin`, removing the browser sandbox escape warning from generated site previews
    - web security headers now use a trimmed `Permissions-Policy` set that avoids unsupported directives rejected by current Chromium builds
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
    - preferred Claude path is AWS Bedrock via IAM role and shell env:
      - `CLAUDE_CODE_USE_BEDROCK=1`
      - `AWS_REGION=us-east-1` (or the configured Bedrock provider region)
      - `ANTHROPIC_DEFAULT_SONNET_MODEL=us.anthropic.claude-sonnet-4-6`
      - `ANTHROPIC_DEFAULT_OPUS_MODEL=us.anthropic.claude-opus-4-7`
      - `ANTHROPIC_DEFAULT_HAIKU_MODEL=us.anthropic.claude-haiku-4-5-20251001-v1:0`
    - fallback path only: `ANTHROPIC_API_KEY` remains supported when no Bedrock provider is configured
  - Claude defaults now prefer AWS Bedrock provider models over direct Anthropic when a Bedrock provider is configured
- Important behavior:
  - Neural Labs no longer writes any MCP server entries into `~/.codex/config.toml`
  - this prevents legacy `onyx` / `wardgpt` MCP bootstrap leakage from imported Codex Labs examples
- Current deployment requirement:
  - `ENABLE_NEURAL_LABS=true` in `deployment/docker_compose/.env`
  - per-user access enabled from Admin Users
  - configure an AWS Bedrock provider with IAM auth and region `us-east-1` to make Bedrock-backed Claude the preferred runtime
  - ensure the runtime EC2 role includes Bedrock Claude access:
    - `bedrock:ListFoundationModels`
      - required for Admin > LLM > Bedrock model discovery (`/api/admin/llm/bedrock/available-models`)
    - `bedrock:InvokeModel`
    - `bedrock:InvokeModelWithResponseStream`
    - `bedrock:ListInferenceProfiles`
    - `bedrock:GetInferenceProfile`
  - for `us.anthropic.*` cross-region inference profiles, invoke permissions must cover the routed Bedrock foundation-model ARNs in all destination regions, not only `us-east-1`
- Note:
  - infrastructure-level Codex/Craft compose wiring remains intentionally separate from this Neural Labs parity import.
