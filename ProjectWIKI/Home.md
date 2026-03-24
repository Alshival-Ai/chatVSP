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
