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
  - after auth/gate checks, it redirects to `NEURAL_LABS_DESKTOP_URL`
  - if the configured URL is a bare root, launcher normalizes it to `/desktop`
  - if `NEURAL_LABS_DESKTOP_URL` is missing/invalid, launcher redirects to `/app`
- Required flags remain:
  - global: `ENABLE_NEURAL_LABS=true`
  - per-user: `Admin -> Users -> Edit user -> Neural Labs Access`
- Runtime ownership:
  - desktop implementation should come from the dedicated Neural Labs repo/container
  - this wiki previously documented an embedded in-repo Neural Labs runtime; those details are now stale and intentionally superseded by the launcher flow
- Claude Code expectation:
  - keep Claude provisioning in the Neural Labs runtime/container image, matching current deployment behavior
