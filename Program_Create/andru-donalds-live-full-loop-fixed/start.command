#!/bin/zsh
set -euo pipefail
PROGRAM_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROGRAM_DIR"
PYTHON_BIN="${ALPHA_PYTHON_BIN:-$(command -v python3)}"
export PLAYWRIGHT_BROWSERS_PATH="${ALPHA_PLAYWRIGHT_BROWSERS_PATH:-/Volumes/petong/Disk/AI/models/playwright-browsers}"
if [[ ! -x .venv/bin/python ]]; then "$PYTHON_BIN" -m venv .venv; fi
.venv/bin/python -m pip install --disable-pip-version-check -r requirements.txt
exec .venv/bin/python bot.py "$@"
