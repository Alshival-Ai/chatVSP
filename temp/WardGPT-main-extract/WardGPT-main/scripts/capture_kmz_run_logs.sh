#!/usr/bin/env bash
set -euo pipefail

# Capture focused KMZ playground logs from nginx/api/web containers.
# Usage:
#   ./scripts/capture_kmz_run_logs.sh [SINCE]
# Examples:
#   ./scripts/capture_kmz_run_logs.sh 20m
#   ./scripts/capture_kmz_run_logs.sh 2h
#
# Default SINCE: 20m

SINCE="${1:-20m}"
TS="$(date -u +"%Y%m%dT%H%M%SZ")"
OUT_DIR="/tmp/kmz-debug-${TS}"
mkdir -p "${OUT_DIR}"

echo "Capturing KMZ logs since: ${SINCE}"
echo "Output directory: ${OUT_DIR}"

docker logs --since "${SINCE}" onyx-nginx-1 > "${OUT_DIR}/nginx.raw.log" 2>&1 || true
docker logs --since "${SINCE}" onyx-api_server-1 > "${OUT_DIR}/api.raw.log" 2>&1 || true
docker logs --since "${SINCE}" onyx-web_server-1 > "${OUT_DIR}/web.raw.log" 2>&1 || true

grep -nE "POST /api/chat/send-chat-message|POST /api/chat/kmz-playground/preprocess| 499 | 504 |upstream timed out|client prematurely closed|chunked|ERR_INCOMPLETE_CHUNKED_ENCODING" \
  "${OUT_DIR}/nginx.raw.log" > "${OUT_DIR}/nginx.kmz.filtered.log" || true

grep -nE "POST /chat/send-chat-message|POST /chat/kmz-playground/preprocess|verify_user_files|load_chat_file took|gather_stream_full took|code_interpreter_client|MCP tool|Exception|Traceback" \
  "${OUT_DIR}/api.raw.log" > "${OUT_DIR}/api.kmz.filtered.log" || true

grep -nE "send-chat-message|ERR_INCOMPLETE_CHUNKED_ENCODING|ResponseAborted|Unhandled|TypeError" \
  "${OUT_DIR}/web.raw.log" > "${OUT_DIR}/web.kmz.filtered.log" || true

echo "Done."
echo "Key files:"
echo "  ${OUT_DIR}/nginx.kmz.filtered.log"
echo "  ${OUT_DIR}/api.kmz.filtered.log"
echo "  ${OUT_DIR}/web.kmz.filtered.log"
