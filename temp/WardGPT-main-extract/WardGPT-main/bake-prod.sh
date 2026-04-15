#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Build images with docker buildx bake, then fully recreate the prod stack and remove orphans.
exec "${SCRIPT_DIR}/tools/bake.sh" --compose-restart --compose-file docker-compose.yml "$@"
