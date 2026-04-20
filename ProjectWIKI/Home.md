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
    - `/neural-labs` now launches directly into the desktop Neural Labs experience; the route-level legacy UI switch and `Back to Legacy UI` action were removed
    - tree-based file navigator (expand/collapse, context menu, drag/drop move, hidden file toggle) remains as implementation support for shared file operations, but the user-facing Neural Labs route now resolves to the desktop shell
    - desktop mode replaces those fixed sidebars with a browser-OS shell: a pill taskbar on the bottom with icon launchers plus windowed `File Explorer`, `Terminal`, `Text Editor`, `Neura`, and `Desktop Settings` apps
    - taskbar apps now show their names on hover via the Neural Labs tooltip treatment instead of always rendering text labels inline
    - desktop taskbar icons restore minimized app windows, focus the front-most running instance on left click, and expose `New Window` on right click for multi-window apps such as `Terminal`, `File Explorer`, `Text Editor`, and `Neura`
    - desktop `Terminal` app is now a separate Windows Terminal-style surface instead of the legacy panel in a window: independent terminal windows, top tab strip, tab context menus, drag-reorder, move-tab-to-new-window, and in-window split controls
    - desktop `Terminal` app now follows the app light/dark theme for both its window chrome and the xterm surface instead of staying hardcoded dark
    - desktop terminal windows keep their own tab and pane state; the desktop app no longer depends on the legacy Terminal Navigator
    - desktop `File Explorer` app now uses a Finder-style explorer instead of the legacy tree navigator: per-window folder history, breadcrumb navigation, sidebar locations, icon/list views, click-through folders, and drag/drop move or upload behavior
    - desktop `File Explorer` iconography now uses explicit theme-aware folder/file colors so the same icon treatment stays readable in both light and dark mode
    - desktop `File Explorer` and `Desktop Settings` now open with wider default window sizes so their initial layouts better match the rest of the Neural Labs desktop apps
    - desktop file explorer windows keep their own path, history, selection, and view mode instead of sharing the legacy navigator state
    - desktop `Text Editor` is now a first-class desktop app window instead of the old preview-window editor: Monaco editor surface, per-window document tabs, open-files sidebar, command menu, manual save/save-as, and dirty-state tracking
    - text files such as `.txt`, `.json`, `.md`, `.py`, and similar now open into the focused desktop editor window as tabs rather than using a separate preview-window editor mode
    - desktop `Neura` is now a dedicated Neural Labs chat app: multi-conversation sidebar, message timeline, streaming replies, and taskbar multi-window behavior using the same desktop shell as the other apps
    - Neura chat history is not stored in Onyx chat tables; it persists inside the user Neural Labs home at `~/.neural-labs/neura/neura.db`
    - new Neura conversations default to the Neural Labs Sonnet model resolved from the managed Claude provider env (`ANTHROPIC_DEFAULT_SONNET_MODEL`)
    - desktop settings now include a color-mode selector for `Auto` / `Light` / `Dark`, default to `Sunset Grid`, allow preset switching without extra per-card helper copy, and support uploading or deleting one custom desktop background image in the persisted Neural Labs workspace
    - desktop mode now opens on a blank workspace without the bordered onboarding card when no windows are open
    - desktop app windows now support macOS-style close/minimize/maximize controls, double-click title-bar maximize/restore, edge snapping (`N/NE/E/SE/S/SW/W/NW`), and minimize-to-taskbar behavior
    - Terminal Navigator now shows a lone terminal as `Terminal 1` without wrapping it in a group; grouped views only appear when a tab actually has multiple panes
    - file action icons now show explicit hover helper text for folder creation, upload, and refresh
    - Neural Labs action hover text now uses the themed white tooltip only; browser-native duplicate tooltips were removed and tooltip positioning is clamped within the viewport above floating windows
    - terminal and group deletion now lives in the Terminal Navigator via trash actions instead of top-bar close controls; standalone terminal and group delete icons are red, while in-group terminal delete icons remain neutral
    - floating preview windows (snap/drag/resize) remain for image, PDF, HTML, KMZ, and XLSX files; text editing is now handled by the dedicated desktop editor app
    - floating preview windows now use the same slimmer Neural Labs desktop window chrome as app windows: matching title-bar density, macOS-style controls, and double-click maximize/restore behavior
    - desktop app windows and preview windows now share the same visual shell while still using separate state models for app windows vs persisted preview windows
    - HTML preview iframe now uses a path-based `/api/neural-labs/files/content/<path>` URL so relative `style.css`, `app.js`, and sibling asset requests resolve inside the selected workspace folder instead of collapsing to `/api/neural-labs/files/*`
    - HTML preview iframe keeps script execution enabled but no longer grants `allow-same-origin`, removing the browser sandbox escape warning from generated site previews
    - web security headers now use a trimmed `Permissions-Policy` set that avoids unsupported directives rejected by current Chromium builds
    - terminal refresh/focus flow now reconciles saved layout against live backend sessions to reduce stale pane or ghost-terminal behavior after reload
    - KMZ/Leaflet preview is loaded client-only to avoid `window is not defined` SSR failures on `/neural-labs`
  - terminal websocket auth aligned for prod (`/api/neural-labs/terminal/ws?token=...&terminal_token=...`)
  - managed shell banner and login profile initialization
  - preinstalled terminal CLIs in Neural Labs backend image:
    - `claude` (Anthropic native installer via `https://claude.ai/install.sh`)
    - image also restores CLI paths from `/etc/profile.d` so login shells still resolve `claude`
  - shell env injection from configured providers:
    - preferred Claude Code path is Microsoft Foundry when the configured `azure` provider uses a Foundry Claude endpoint (`https://{resource}.services.ai.azure.com/anthropic`):
      - `CLAUDE_CODE_USE_FOUNDRY=1`
      - `ANTHROPIC_FOUNDRY_BASE_URL=https://{resource}.services.ai.azure.com/anthropic`
      - optional: `ANTHROPIC_FOUNDRY_API_KEY` from the Azure provider API key
      - pinned defaults:
        - `ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-4-6`
        - `ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-7`
        - `ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-4-5`
    - otherwise Claude Code falls back to AWS Bedrock via IAM role and shell env:
      - `CLAUDE_CODE_USE_BEDROCK=1`
      - `AWS_REGION=us-east-1` (or the configured Bedrock provider region)
      - `ANTHROPIC_DEFAULT_SONNET_MODEL=us.anthropic.claude-sonnet-4-6`
      - `ANTHROPIC_DEFAULT_OPUS_MODEL=global.anthropic.claude-opus-4-6-v1`
      - `ANTHROPIC_DEFAULT_HAIKU_MODEL=us.anthropic.claude-haiku-4-5-20251001-v1:0`
    - fallback path only: `ANTHROPIC_API_KEY` remains supported when neither Foundry nor Bedrock is configured
  - Claude defaults now prefer AWS Bedrock provider models over direct Anthropic when a Bedrock provider is configured
  - Neural Labs no longer provisions OpenAI/Codex credentials or config; the managed shell is Claude-only
  - Build/Craft sandbox sessions now resolve Bedrock Claude only and pass the selected Bedrock region into the local `opencode` subprocess
- Important behavior:
  - managed Claude shell env is persisted into `~/.neural_labs_env` and sourced from `~/.bashrc`
  - Neural Labs recreates existing terminal sessions when managed env overrides change, so stale Claude provider/model state is not reused across launches
- Current deployment requirement:
  - `ENABLE_NEURAL_LABS=true` in `deployment/docker_compose/.env`
  - per-user access enabled from Admin Users
  - to provision Claude Code from Azure Foundry, configure an `azure` provider whose `api_base` points at the Foundry Claude endpoint (`https://{resource}.services.ai.azure.com/anthropic`)
  - configure an AWS Bedrock provider with IAM auth and region `us-east-1` to make Bedrock-backed Claude the preferred runtime
  - current Neural Labs Bedrock Opus default is `global.anthropic.claude-opus-4-6-v1`
    - this account currently rejects Opus 4.7 with AWS Marketplace entitlement errors, while Opus 4.6 invokes successfully
  - current Onyx app Bedrock default chat model is also `global.anthropic.claude-opus-4-6-v1`
    - live Bedrock Claude visibility is restricted to Opus 4.6 plus Haiku 4.5 so the app does not keep surfacing failing Sonnet 4.6 / Opus 4.7 entries
  - ensure the runtime EC2 role includes Bedrock Claude access:
    - `bedrock:ListFoundationModels`
      - required for Admin > LLM > Bedrock model discovery (`/api/admin/llm/bedrock/available-models`)
    - `bedrock:InvokeModel`
    - `bedrock:InvokeModelWithResponseStream`
    - `bedrock:ListInferenceProfiles`
    - `bedrock:GetInferenceProfile`
  - for `us.anthropic.*` cross-region inference profiles, invoke permissions must cover the routed Bedrock foundation-model ARNs in all destination regions, not only `us-east-1`
- Note:
  - Craft onboarding and recommended model selection are now Bedrock Claude only; legacy OpenAI/OpenRouter onboarding choices were removed from the curated flow.
