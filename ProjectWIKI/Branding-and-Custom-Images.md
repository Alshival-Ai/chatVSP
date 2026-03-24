# Branding and Custom Images

## Why the App Can Look Like Stock Onyx

`docker-compose.prod.yml` references image names like:

- `onyxdotapp/onyx-web-server:${IMAGE_TAG}`
- `onyxdotapp/onyx-backend:${IMAGE_TAG}`

If you run `docker compose pull` and then `up` without building, runtime may use upstream Onyx images.

## Where ChatVSP Branding Lives

Examples in source:

- `web/src/refresh-components/Logo.tsx` (default app name `chatVSP`)
- `web/src/app/layout.tsx` (metadata title fallback `chatVSP`)
- many `web/src/**` text labels updated to ChatVSP

## Correct Deploy Pattern for Custom Branding

Build from this repository before starting/restarting app services:

```bash
cd deployment/docker_compose
sudo docker compose -f docker-compose.prod.yml build web_server api_server background
sudo docker compose -f docker-compose.prod.yml up -d --no-deps web_server api_server background nginx
```

## Optional Hardening

To avoid accidental stock-image pulls in future:

- avoid routine `docker compose pull` for custom services
- maintain an override file with custom image names/tags
- publish your own ChatVSP images to a private registry and reference those tags
