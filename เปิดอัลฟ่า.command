#!/bin/zsh
set -euo pipefail

ALPHA_LAUNCHER_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$ALPHA_LAUNCHER_DIR/start-alpha.command"
