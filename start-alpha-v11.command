#!/bin/zsh
set -euo pipefail

ALPHA_DIR="$(cd "$(dirname "$0")" && pwd)"
ALPHA_TOOL_SERVICE="com.alpha.local.tools"
ALPHA_TOOL_LOG_FILE="/tmp/alpha-tool.stdout.log"
ALPHA_TOOL_ERROR_LOG_FILE="/tmp/alpha-tool.stderr.log"

cd "$ALPHA_DIR"

if command -v node >/dev/null 2>&1; then
  ALPHA_NODE_BIN="$(command -v node)"
elif [[ -x "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" ]]; then
  ALPHA_NODE_BIN="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
else
  echo "ไม่พบ Node.js สำหรับ Alpha v1.1 preview"
  exit 1
fi

"$ALPHA_NODE_BIN" "$ALPHA_DIR/scripts/apply-beta3-runtime-patch.mjs" "$ALPHA_DIR"

zsh "$ALPHA_DIR/stop-alpha.command" >/dev/null 2>&1 || true
zsh "$ALPHA_DIR/start-alpha.command"

ALPHA_TOOL_TOKEN="$(sed -n 's/^ALPHA_TOOL_TOKEN=//p' "$ALPHA_DIR/.dev.vars" | head -n 1 | tr -d '[:space:]')"
if [[ ${#ALPHA_TOOL_TOKEN} -lt 32 ]]; then
  echo "ไม่พบ ALPHA_TOOL_TOKEN ที่ใช้งานได้"
  exit 1
fi

launchctl remove "$ALPHA_TOOL_SERVICE" >/dev/null 2>&1 || true
sleep 0.3

for PORT in 4317 4318; do
  for PID in $(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null || true); do
    CMD="$(ps -p "$PID" -o command= 2>/dev/null || true)"
    if [[ "$CMD" == *"tool-service/server.mjs"* || "$CMD" == *"tool-service/server-wrapper-preview.mjs"* || "$CMD" == *"tool-service/server-wrapper-beta3.mjs"* ]]; then
      kill "$PID" >/dev/null 2>&1 || true
    fi
  done
done
sleep 0.4

echo "กำลังเปิด Alpha v1.1 beta3 Host Tool Controller..."
launchctl submit -l "$ALPHA_TOOL_SERVICE" \
  -o "$ALPHA_TOOL_LOG_FILE" \
  -e "$ALPHA_TOOL_ERROR_LOG_FILE" \
  -- "$ALPHA_NODE_BIN" "$ALPHA_DIR/tool-service/server-wrapper-beta3.mjs" "$ALPHA_DIR"

READY=false
for _ in {1..50}; do
  HEALTH="$(curl --max-time 2 -fsS -H "Authorization: Bearer $ALPHA_TOOL_TOKEN" http://127.0.0.1:4317/v1/health 2>/dev/null || true)"
  if [[ "$HEALTH" == *'"host_capability_ready":true'* && "$HEALTH" == *'"approval_store":"persistent"'* ]]; then
    READY=true
    break
  fi
  sleep 0.5
done

if [[ "$READY" != true ]]; then
  echo "Alpha v1.1 beta3 Host Tool Controller เปิดไม่สำเร็จ"
  echo "ดู log: $ALPHA_TOOL_ERROR_LOG_FILE"
  exit 1
fi

echo "Alpha v1.1 beta3 พร้อม: persistent approval + self-install + auto-resume"
open "http://localhost:3000" >/dev/null 2>&1 || true
