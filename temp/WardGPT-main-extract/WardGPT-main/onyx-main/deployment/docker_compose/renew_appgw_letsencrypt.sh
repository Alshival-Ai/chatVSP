#!/usr/bin/env bash
set -euo pipefail

# Renews Let's Encrypt cert for DOMAIN, imports into Key Vault,
# and updates Application Gateway SSL certificate binding.

DOMAIN="${DOMAIN:-gpt.wardelectriccompany.com}"
KEY_VAULT_NAME="${KEY_VAULT_NAME:-wardgptkvwestus2}"
KEY_VAULT_CERT_NAME="${KEY_VAULT_CERT_NAME:-wardgpt-prosourceit-le}"
APPGW_RESOURCE_GROUP="${APPGW_RESOURCE_GROUP:-wardgpt-rg}"
APPGW_NAME="${APPGW_NAME:-wardgpt-appgw}"
APPGW_SSL_CERT_NAME="${APPGW_SSL_CERT_NAME:-wardgpt-kv-cert}"
NGINX_CONTAINER="${NGINX_CONTAINER:-onyx-nginx-1}"
CERTBOT_STATE_DIR="${CERTBOT_STATE_DIR:-/home/wardgptadmin/certbot}"
LETSENCRYPT_EMAIL="${LETSENCRYPT_EMAIL:-}"

CERTBOT_ETC_DIR="$CERTBOT_STATE_DIR/etc"
CERTBOT_LIB_DIR="$CERTBOT_STATE_DIR/lib"
CERTBOT_OUT_DIR="$CERTBOT_STATE_DIR/out"
LOCK_FILE="${LOCK_FILE:-/tmp/renew_appgw_letsencrypt.lock}"

mkdir -p "$CERTBOT_ETC_DIR" "$CERTBOT_LIB_DIR" "$CERTBOT_OUT_DIR"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Another renewal process is running. Exiting."
  exit 0
fi

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_cmd az
require_cmd docker
require_cmd openssl

started_nginx=0
start_nginx_if_stopped() {
  if [[ "$started_nginx" -eq 1 ]]; then
    docker start "$NGINX_CONTAINER" >/dev/null || true
    started_nginx=0
  fi
}
trap start_nginx_if_stopped EXIT

if docker ps --format '{{.Names}}' | grep -Fxq "$NGINX_CONTAINER"; then
  echo "Stopping $NGINX_CONTAINER to free port 80 for ACME challenge..."
  docker stop "$NGINX_CONTAINER" >/dev/null
  started_nginx=1
fi

echo "Running certbot for $DOMAIN..."
certbot_args=(
  certonly
  --standalone
  --preferred-challenges http
  --non-interactive
  --agree-tos
  --keep-until-expiring
  -d "$DOMAIN"
)
if [[ -n "$LETSENCRYPT_EMAIL" ]]; then
  certbot_args+=(--email "$LETSENCRYPT_EMAIL")
else
  certbot_args+=(--register-unsafely-without-email)
fi

docker run --rm -p 80:80 \
  -v "$CERTBOT_ETC_DIR:/etc/letsencrypt" \
  -v "$CERTBOT_LIB_DIR:/var/lib/letsencrypt" \
  certbot/certbot "${certbot_args[@]}"

# Bring nginx back immediately after ACME step.
start_nginx_if_stopped

# Compute local cert SHA1 thumbprint
local_thumbprint="$({
  docker run --rm \
    -v "$CERTBOT_ETC_DIR:/etc/letsencrypt:ro" \
    alpine:3.20 sh -lc "apk add --no-cache openssl >/dev/null && openssl x509 -in /etc/letsencrypt/live/$DOMAIN/fullchain.pem -noout -fingerprint -sha1" \
    | awk -F'=' '{print $2}' \
    | tr -d ':'
} | tr '[:lower:]' '[:upper:]')"

if [[ -z "$local_thumbprint" ]]; then
  echo "Failed to compute local certificate thumbprint." >&2
  exit 1
fi

kv_thumbprint="$(az keyvault certificate show --vault-name "$KEY_VAULT_NAME" -n "$KEY_VAULT_CERT_NAME" --query x509ThumbprintHex -o tsv 2>/dev/null || true)"
kv_thumbprint="$(echo "$kv_thumbprint" | tr '[:lower:]' '[:upper:]')"

echo "Local thumbprint: $local_thumbprint"
if [[ -n "$kv_thumbprint" ]]; then
  echo "Key Vault thumbprint: $kv_thumbprint"
fi

if [[ -n "$kv_thumbprint" && "$local_thumbprint" == "$kv_thumbprint" ]]; then
  echo "Certificate unchanged. Skipping Key Vault/App Gateway update."
  exit 0
fi

pfx_password="$(openssl rand -base64 24 | tr -d '\n')"
pfx_path="$CERTBOT_OUT_DIR/$DOMAIN.pfx"

echo "Creating PFX bundle..."
docker run --rm \
  -v "$CERTBOT_ETC_DIR:/etc/letsencrypt:ro" \
  -v "$CERTBOT_OUT_DIR:/out" \
  alpine:3.20 sh -lc "
    set -e
    apk add --no-cache openssl >/dev/null
    openssl pkcs12 -export \
      -out /out/cert.pfx \
      -inkey /etc/letsencrypt/live/$DOMAIN/privkey.pem \
      -in /etc/letsencrypt/live/$DOMAIN/fullchain.pem \
      -password pass:$pfx_password
    chmod 644 /out/cert.pfx
  "
mv "$CERTBOT_OUT_DIR/cert.pfx" "$pfx_path"

echo "Importing certificate into Key Vault ($KEY_VAULT_NAME/$KEY_VAULT_CERT_NAME)..."
az keyvault certificate import \
  --vault-name "$KEY_VAULT_NAME" \
  -n "$KEY_VAULT_CERT_NAME" \
  -f "$pfx_path" \
  --password "$pfx_password" -o none

sid="$(az keyvault certificate show --vault-name "$KEY_VAULT_NAME" -n "$KEY_VAULT_CERT_NAME" --query sid -o tsv)"
versionless_sid="${sid%/*}"

echo "Updating Application Gateway SSL cert binding..."
az network application-gateway ssl-cert update \
  -g "$APPGW_RESOURCE_GROUP" \
  --gateway-name "$APPGW_NAME" \
  -n "$APPGW_SSL_CERT_NAME" \
  --key-vault-secret-id "$versionless_sid" -o none

echo "Renewal sync complete."
