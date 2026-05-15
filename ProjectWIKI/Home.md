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

- Neural Labs is now launcher-based from chatVSP:
  - `/neural-labs` keeps primary Onyx auth + feature gating
  - after auth/gate checks, it signs a short-lived trusted-login token
  - the default target is the bundled local desktop at `/neural-labs-app/desktop`
- Required flags remain:
  - global: `ENABLE_NEURAL_LABS=true`
  - per-user: `Admin -> Users -> Edit user -> Neural Labs Access`
- Runtime ownership:
  - desktop implementation is vendored under `neural-labs/`
  - Docker Compose builds `neural_labs` and `neural_labs_workspace` with the normal prod bake flow
- Claude Code:
  - the bundled workspace image installs the `claude` CLI
  - runtime Claude/Bedrock env is passed into Neural Labs workspace containers
