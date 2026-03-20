#!/usr/bin/env bash
set -euo pipefail

profile="default"
down_first=0
no_cache=0
pull_first=0
no_wait=0
services=()

usage() {
  cat <<'EOF'
Usage: tools/bake.sh [options] [services...]

Options:
  --profile <dev|default|multitenant>
  --down-first
  --no-cache
  --pull
  --no-wait
  -h, --help
EOF
}

while (($# > 0)); do
  case "$1" in
    --profile)
      if (($# < 2)); then
        echo "Missing value for --profile" >&2
        exit 1
      fi
      profile="$2"
      shift 2
      ;;
    --down-first)
      down_first=1
      shift
      ;;
    --no-cache)
      no_cache=1
      shift
      ;;
    --pull)
      pull_first=1
      shift
      ;;
    --no-wait)
      no_wait=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      services+=("$@")
      break
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      services+=("$1")
      shift
      ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker CLI not found in PATH." >&2
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
compose_dir="$(cd -- "${script_dir}/../deployment/docker_compose" && pwd)"

compose_args=(compose -p onyx)
case "$profile" in
  dev)
    compose_args+=(-f docker-compose.yml -f docker-compose.dev.yml)
    ;;
  default)
    compose_args+=(-f docker-compose.yml)
    ;;
  multitenant)
    compose_args+=(-f docker-compose.multitenant-dev.yml)
    ;;
  *)
    echo "Invalid profile: $profile" >&2
    exit 1
    ;;
esac

cd "$compose_dir"

if ((down_first)); then
  docker "${compose_args[@]}" down --remove-orphans
fi

if ((pull_first)); then
  docker "${compose_args[@]}" pull
fi

build_args=("${compose_args[@]}" build)
if ((no_cache)); then
  build_args+=(--no-cache)
fi
if ((${#services[@]} > 0)); then
  build_args+=("${services[@]}")
fi
docker "${build_args[@]}"

up_args=("${compose_args[@]}" up -d --force-recreate)
if ((!no_wait)); then
  up_args+=(--wait)
fi
if ((${#services[@]} > 0)); then
  up_args+=("${services[@]}")
fi
docker "${up_args[@]}"
