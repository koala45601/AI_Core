#!/bin/zsh
set -euo pipefail
PROGRAM_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROGRAM_DIR"
exec "$PROGRAM_DIR/start.command" --wait-for-window --confirm-order
