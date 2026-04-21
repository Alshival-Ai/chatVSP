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
- UI presentation:
  - the route resolves directly to the desktop Neural Labs shell; the former legacy/Desktop route toggle has been removed
- API prefix: `/api/neural-labs/*`
- Terminal websocket path returned by token API:
  - `/api/neural-labs/terminal/ws?token=<auth_token>&terminal_token=<terminal_ticket>`
- Per-user workspace root:
  - `${PERSISTENT_DOCUMENT_STORAGE_PATH}/${tenant_id}/neural-labs/${user_id}`
- File API status semantics:
  - missing files or directories now return `404`
  - invalid paths and traversal-style input return `400`
  - conflicting create / move / rename operations return `409`
- Frontend tree state recovery:
  - the Neural Labs file tree persists expanded and selected paths in browser storage
  - if a persisted directory no longer exists, the frontend clears that stale entry when the API returns `404`
- Frontend route behavior:
  - the `/neural-labs` page now resolves directly to the desktop shell; the former route-level legacy/Desktop presentation toggle is no longer exposed in the UI
- Frontend window model:
  - floating preview windows remain a persisted client model for non-editor file previews (image, PDF, HTML, KMZ, XLSX)
  - desktop app windows (`File Explorer`, `Terminal`, `Text Editor`, `Neura`, `Desktop Settings`) are client-side windows layered into the same workspace and focus ordering
  - the desktop window workspace spans under the pinned top header overlay, and the header sits behind the window stack while the taskbar remains above it, so snapped/maximized windows can occupy the full top edge without the header painting over window chrome
  - the taskbar chrome now switches between dark and light glass treatments with matching icon/button contrast, rather than assuming a dark backdrop behind the dock
  - taskbar app icon foreground classes now resolve from stable theme-specific idle/running/active states so icon color returns correctly after a window is closed
  - preview windows now render through the same desktop-style chrome treatment as app windows (matching compact title bar, macOS-style controls, shared snap/maximize affordances) while keeping their existing persisted preview content/state model
  - desktop app windows track snapped, maximized, and minimized state on the client so taskbar restore/focus behavior does not require backend changes
  - the desktop top-bar environment badge now uses a one-time Neural Labs warmup on desktop load instead of waiting for a visible terminal tab, so the shell can show `Ready` even before the Terminal app is opened
  - the desktop shell now rehydrates missing per-window app state maps from the live window list so a terminal/editor/explorer window cannot get stranded on a fallback initializing shell after client-side state drift
  - desktop file explorer windows keep separate per-window navigation state (`current_path`, back/forward history, selection, and icon/list mode) while reusing the shared file API/cache layer
  - desktop terminal windows keep separate per-window terminal ownership and layout state (`tabs`, `active_tab_id`, split panes) so the Windows Terminal-style desktop app does not leak terminal sessions into the legacy terminal workspace
  - desktop editor windows keep separate per-window editor state (`tabs`, `active_tab_id`, sidebar visibility) while text-file loads/saves continue to use the existing file-content API
  - desktop editor surface chrome now normalizes its sidebar, compact toolbar, tab strip, editor canvas, and save modal around the active light/dark theme instead of mixing palette treatments
  - the desktop text editor now relies on Monaco's official stylesheet (imported at app root) and runs Monaco in the normal document styling path (`useShadowDOM: false`) for Neural Labs, so cursor/input behavior stays aligned with Monaco defaults instead of custom host-level CSS overrides
  - Monaco loader initialization in the desktop editor is now pinned to the locally bundled `monaco-editor` instance (`loader.config({ monaco })`) so strict CSP environments do not attempt jsDelivr stylesheet/script fetches
  - desktop Neura windows keep separate per-window chat view state (`selected_conversation_id`, drafts, sidebar visibility, streaming state, pending image attachments`) while the persisted conversation/message history lives under the user Neural Labs home
  - Neura client-state hydration now normalizes message payloads and attachment arrays so missing optional fields from stream/history responses do not trigger render-time `undefined.length` crashes
  - selected sidebar rows in the desktop editor and Neura now set their own active-state foreground colors explicitly instead of relying on inherited text tokens from the shared `Text` component
  - the Neura composer now renders icon-only action affordances with tooltip labels and keeps a non-functional voice button in the layout as a placeholder, while the keyboard shortcut hint lives below the composer shell
  - a newly opened Neura window auto-bootstraps its first conversation client-side once the conversation list is confirmed empty, then focuses the composer for immediate typing
  - text-like files now route into the desktop editor window model instead of the preview-window model
  - previewability and text-editability are now treated separately in the file explorer/tree: HTML can be previewed as a rendered page while editable text-like files expose an explicit `Open in Text Editor` action
  - desktop explorer/terminal presentation colors now follow the shared app light/dark theme; the terminal xterm theme is switched client-side alongside the window chrome
  - XLSX preview tables now use explicit theme-aware cell/header colors rather than relying on generic token classes that could collapse to white-on-white in light mode
  - desktop presentation preferences such as the selected preset/custom background choice persist in browser storage on the client
  - uploaded custom desktop background images are stored in the user Neural Labs workspace under `~/.neural-labs/backgrounds/` and served back through the existing file-content API
  - desktop file explorer image context menus can set a selected image as the active desktop background by copying it into the managed `~/.neural-labs/backgrounds/` location and reusing the same settings-managed custom background path flow
  - Neura uses separate Neural Labs endpoints under `/api/neural-labs/neura/*` and a local SQLite store at `~/.neural-labs/neura/neura.db`; it does not create Onyx chat sessions/messages or use the `query_and_chat` persistence model
  - Neura image uploads are stored in `~/.neural-labs/neura/uploads/`, attached to user messages in the local SQLite metadata, and translated into multimodal message parts for the configured default chat model
  - default model selection for new Neura conversations resolves from the same CHAT default model flow used by `Admin -> Language Models`, rather than a Neural Labs-only hardcoded Sonnet default

## SSH Path

- `ssh-chatvsp.vsp-app-aws-us-west-2.com` resolves to NLB
- NLB forwards TCP/22 to the same EC2 instance
