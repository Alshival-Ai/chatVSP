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

- Neural Labs is being ported in as a contained feature, not a full WardGPT fork merge.
- Current live slice includes:
  - `enable_neural_labs` on users
  - admin toggle support
  - gated `/neural-labs` route
  - compose/runtime flag `ENABLE_NEURAL_LABS`
  - per-user persistent workspace rooted under the shared `file-system` volume
  - backend workspace APIs for warmup, file listing, file read, upload, folder create, rename, move, text save, and delete
  - web UI for browsing folders and previewing common file types
  - live terminal UI with terminal creation, restart, close pane, and terminal navigator
  - split terminal workspace modes (vertical / horizontal)
  - terminal websocket auth aligned for prod (`/api/neural-labs/terminal/ws?token=...&terminal_token=...`)
  - managed shell banner and login profile initialization
  - per-user Codex config bootstrap at `~/.codex/config.toml`
  - OpenAI-only Codex runtime config using credentials from Onyx LLM provider settings
  - fixed OpenAI endpoint in Codex config (`https://api.openai.com/v1`)
- Current deployment requirement:
  - `ENABLE_NEURAL_LABS=true` in `deployment/docker_compose/.env`
  - per-user access enabled from Admin Users
- Still pending:
  - richer multi-window previews
  - drag/drop move flows
  - optional UX enhancements for file previews

Neural Labs deliberately does not provision custom MCP servers or custom skills in chatVSP.
