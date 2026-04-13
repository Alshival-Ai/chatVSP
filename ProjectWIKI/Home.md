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

## Current Production Endpoints (2026-03-24)

- App: `https://chatvsp.vsp-app-aws-us-west-2.com`
- SSH: `ssh-chatvsp.vsp-app-aws-us-west-2.com:22`

## Important Rule

If you want ChatVSP custom UI/behavior, do not rely only on pulled `onyxdotapp/*` images. Build from this repository for `web_server` and backend services.

## Codex Labs Status

- Codex Labs is being ported in as a contained feature, not a full WardGPT fork merge.
- Current live slice includes:
  - `enable_codex_labs` on users
  - admin toggle support
  - gated `/codex-labs` route
  - compose/runtime flag `ENABLE_CODEX_LABS`
  - per-user persistent workspace rooted under the shared `file-system` volume
  - backend workspace APIs for warmup, file listing, file read, upload, folder create, rename, move, text save, and delete
  - web UI for browsing folders and previewing common file types
- Current deployment requirement:
  - `ENABLE_CODEX_LABS=true` in `deployment/docker_compose/.env`
  - per-user access enabled from Admin Users
- Still pending:
  - terminal/session manager
  - richer multi-window previews
  - drag/drop move flows
  - MCP/Codex provisioning layer
