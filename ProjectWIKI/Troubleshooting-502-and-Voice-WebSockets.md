# Troubleshooting 502 and Voice WebSockets

## 502 at ALB

Common causes:

- nginx container crash loop
- API not ready
- ALB health check path misconfigured

### Known incident (2026-03-24)

- nginx used TLS template expecting local certbot files
- local cert files were missing because TLS is terminated at ALB/ACM
- nginx restarted repeatedly, ALB returned `502`

Fix:

- run nginx HTTP template mode on instance
- keep TLS at ALB
- set target group health check path to `/api/health`

## Voice WebSocket Failures

Checklist:

- `WEB_DOMAIN` exactly matches browser origin
- nginx forwards WebSocket headers for `/api/*`
- backend sees proper `X-Forwarded-*` headers

Expected failure signature when `WEB_DOMAIN` is wrong:

- origin mismatch in backend logs
