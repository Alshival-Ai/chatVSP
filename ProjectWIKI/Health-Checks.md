# Health Checks

## Public App

```bash
curl -I https://chatvsp.vsp-app-aws-us-west-2.com
```

Expected: `307` redirects into app/login paths (normal for auth flows).

## API Health

```bash
curl -sS http://localhost/api/health
```

Expected payload:

```json
{"success":true,"message":"ok","data":null}
```

## ALB Target Group

- Path: `/api/health`
- Matcher: `200-399`

## Docker Service Snapshot

```bash
cd deployment/docker_compose
sudo docker compose -f docker-compose.prod.yml ps
```

Verify `api_server`, `web_server`, `nginx`, `opensearch`, `index` are up.
