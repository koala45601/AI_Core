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

echo "กำลังเตรียม Alpha v1.1.0-beta.21..."
"$ALPHA_NODE_BIN" "$ALPHA_DIR/scripts/apply-beta3-runtime-patch.mjs" "$ALPHA_DIR"
"$ALPHA_NODE_BIN" "$ALPHA_DIR/scripts/recover-beta3-approvals.mjs" "$ALPHA_DIR"
"$ALPHA_NODE_BIN" "$ALPHA_DIR/scripts/apply-beta4-shell-artifacts.mjs" "$ALPHA_DIR"
"$ALPHA_NODE_BIN" "$ALPHA_DIR/scripts/apply-beta4-batch-install-v2.mjs" "$ALPHA_DIR"
"$ALPHA_NODE_BIN" "$ALPHA_DIR/scripts/apply-beta4-tool-schema.mjs" "$ALPHA_DIR"
"$ALPHA_NODE_BIN" "$ALPHA_DIR/scripts/apply-beta4-chat-runtime-v2.mjs" "$ALPHA_DIR"
"$ALPHA_NODE_BIN" "$ALPHA_DIR/scripts/apply-beta4-loop-hardening-v2.mjs" "$ALPHA_DIR"
"$ALPHA_NODE_BIN" "$ALPHA_DIR/scripts/apply-beta4-task-ui-v2.mjs" "$ALPHA_DIR"
"$ALPHA_NODE_BIN" "$ALPHA_DIR/scripts/apply-beta5-adaptive-reasoning.mjs" "$ALPHA_DIR"
"$ALPHA_NODE_BIN" "$ALPHA_DIR/scripts/apply-beta6-host-filesystem.mjs" "$ALPHA_DIR"
"$ALPHA_NODE_BIN" "$ALPHA_DIR/scripts/apply-beta7-file-workflow-recovery.mjs" "$ALPHA_DIR"
"$ALPHA_NODE_BIN" "$ALPHA_DIR/scripts/apply-beta8-permission-domains.mjs" "$ALPHA_DIR"
"$ALPHA_NODE_BIN" "$ALPHA_DIR/scripts/apply-beta9-auto-grow-composer.mjs" "$ALPHA_DIR"
"$ALPHA_NODE_BIN" "$ALPHA_DIR/scripts/apply-beta10-persistent-search.mjs" "$ALPHA_DIR"
"$ALPHA_NODE_BIN" "$ALPHA_DIR/scripts/apply-beta10-host-execution.mjs" "$ALPHA_DIR"
"$ALPHA_NODE_BIN" "$ALPHA_DIR/scripts/apply-beta11-full-host-permission.mjs" "$ALPHA_DIR"
"$ALPHA_NODE_BIN" "$ALPHA_DIR/scripts/apply-beta12-host-access-routing.mjs" "$ALPHA_DIR"
"$ALPHA_NODE_BIN" "$ALPHA_DIR/scripts/apply-beta13-nonblocking-post-response.mjs" "$ALPHA_DIR"
"$ALPHA_NODE_BIN" "$ALPHA_DIR/scripts/apply-beta14-auto-learn-recovery.mjs" "$ALPHA_DIR"
"$ALPHA_NODE_BIN" "$ALPHA_DIR/scripts/apply-beta14-ticket-workflow.mjs" "$ALPHA_DIR"
"$ALPHA_NODE_BIN" "$ALPHA_DIR/scripts/apply-beta21-ticket-runtime.mjs" "$ALPHA_DIR"

"$ALPHA_NODE_BIN" --check "$ALPHA_DIR/tool-service/server.mjs"
"$ALPHA_NODE_BIN" --check "$ALPHA_DIR/lib/ticket-workflow.js"
"$ALPHA_NODE_BIN" --check "$ALPHA_DIR/tool-service/ticket-run-manager.mjs"
"$ALPHA_NODE_BIN" --check "$ALPHA_DIR/tool-service/server-wrapper-beta3.mjs"
"$ALPHA_NODE_BIN" --check "$ALPHA_DIR/scripts/apply-beta4-batch-install-v2.mjs"
"$ALPHA_NODE_BIN" --check "$ALPHA_DIR/scripts/apply-beta4-chat-runtime-v2.mjs"
"$ALPHA_NODE_BIN" --check "$ALPHA_DIR/scripts/apply-beta4-loop-hardening-v2.mjs"
"$ALPHA_NODE_BIN" --check "$ALPHA_DIR/scripts/apply-beta4-task-ui-v2.mjs"
"$ALPHA_NODE_BIN" --check "$ALPHA_DIR/scripts/apply-beta5-adaptive-reasoning.mjs"
"$ALPHA_NODE_BIN" --check "$ALPHA_DIR/scripts/apply-beta6-host-filesystem.mjs"
"$ALPHA_NODE_BIN" --check "$ALPHA_DIR/scripts/apply-beta7-file-workflow-recovery.mjs"
"$ALPHA_NODE_BIN" --check "$ALPHA_DIR/scripts/apply-beta8-permission-domains.mjs"
"$ALPHA_NODE_BIN" --check "$ALPHA_DIR/scripts/apply-beta9-auto-grow-composer.mjs"
"$ALPHA_NODE_BIN" --check "$ALPHA_DIR/scripts/apply-beta10-persistent-search.mjs"
"$ALPHA_NODE_BIN" --check "$ALPHA_DIR/scripts/apply-beta10-host-execution.mjs"
"$ALPHA_NODE_BIN" --check "$ALPHA_DIR/scripts/apply-beta11-full-host-permission.mjs"
"$ALPHA_NODE_BIN" --check "$ALPHA_DIR/scripts/apply-beta12-host-access-routing.mjs"
"$ALPHA_NODE_BIN" --check "$ALPHA_DIR/scripts/apply-beta13-nonblocking-post-response.mjs"
"$ALPHA_NODE_BIN" --check "$ALPHA_DIR/scripts/apply-beta14-auto-learn-recovery.mjs"
"$ALPHA_NODE_BIN" --check "$ALPHA_DIR/scripts/apply-beta14-ticket-workflow.mjs"
"$ALPHA_NODE_BIN" --check "$ALPHA_DIR/scripts/apply-beta21-ticket-runtime.mjs"
"$ALPHA_NODE_BIN" --check "$ALPHA_DIR/scripts/install-security-skills.mjs"
"$ALPHA_NODE_BIN" --check "$ALPHA_DIR/lib/ollama.ts" >/dev/null 2>&1 || true

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

echo "กำลังเปิด Alpha beta21 Host Tool Controller..."
launchctl submit -l "$ALPHA_TOOL_SERVICE" \
  -o "$ALPHA_TOOL_LOG_FILE" \
  -e "$ALPHA_TOOL_ERROR_LOG_FILE" \
  -- "$ALPHA_NODE_BIN" "$ALPHA_DIR/tool-service/server-wrapper-beta3.mjs" "$ALPHA_DIR"

READY=false
SEARCH_READY=false
for _ in {1..120}; do
  HEALTH="$(curl --max-time 2 -fsS -H "Authorization: Bearer $ALPHA_TOOL_TOKEN" http://127.0.0.1:4317/v1/health 2>/dev/null || true)"
  if [[ "$HEALTH" == *'"host_capability_ready":true'* && "$HEALTH" == *'"host_filesystem_ready":true'* && "$HEALTH" == *'"approval_store":"persistent"'* ]]; then
    READY=true
  fi
  if [[ "$HEALTH" == *'"searxng_connected":true'* ]]; then
    SEARCH_READY=true
  fi
  if [[ "$READY" == true && "$SEARCH_READY" == true ]]; then
    break
  fi
  sleep 0.5
done

if [[ "$READY" != true ]]; then
  echo "Alpha beta21 Host Tool Controller เปิดไม่สำเร็จ"
  echo "ดู log: $ALPHA_TOOL_ERROR_LOG_FILE"
  exit 1
fi

if [[ "$SEARCH_READY" == true ]]; then
  echo "SearXNG พร้อมและจะคงทำงานตลอด session ของ Alpha"
else
  echo "คำเตือน: Alpha พร้อมแล้ว แต่ SearXNG ยังไม่พร้อม ระบบ keepalive จะพยายามกู้บริการต่อทุก 30 วินาที"
  echo "ดู log: $ALPHA_TOOL_ERROR_LOG_FILE"
fi

ALPHA_SKILL_ROOT="$ALPHA_DIR/outputs/Alpha Outputs/Learned Skills"
ALPHA_REQUIRED_SKILLS=(
  authorized-api-traffic-analyzer
  system-access-capability-mapper
  cybersecurity-audit-prioritizer
  web-api-contract-discovery
  concert-ticket-purchase-assistant
)
ALPHA_INSTALL_SKILLS=false
for ALPHA_SKILL_ID in "${ALPHA_REQUIRED_SKILLS[@]}"; do
  if [[ ! -f "$ALPHA_SKILL_ROOT/$ALPHA_SKILL_ID/alpha-skill.json" ]]; then
    ALPHA_INSTALL_SKILLS=true
    break
  fi
done
if [[ ! -f "$ALPHA_SKILL_ROOT/concert-ticket-purchase-assistant/main.py" ]] || ! grep -q "payment_kbankqr.php" "$ALPHA_SKILL_ROOT/concert-ticket-purchase-assistant/main.py" || ! grep -q "LOGIN_REQUIRED_BEFORE_CHECKOUT" "$ALPHA_SKILL_ROOT/concert-ticket-purchase-assistant/main.py" || ! grep -q "preferredSeatNumbers" "$ALPHA_SKILL_ROOT/concert-ticket-purchase-assistant/main.py" || ! grep -q "runtimeDiscoveryRequired" "$ALPHA_SKILL_ROOT/concert-ticket-purchase-assistant/main.py"; then
  ALPHA_INSTALL_SKILLS=true
fi
if [[ "$ALPHA_INSTALL_SKILLS" == true ]]; then
  echo "กำลังทดสอบและติดตั้งสกิลแกนหลักที่ยังขาด..."
  "$ALPHA_NODE_BIN" "$ALPHA_DIR/scripts/install-security-skills.mjs" "$ALPHA_DIR"
else
  echo "สกิลแกนหลัก Beta19 ติดตั้งครบแล้ว"
fi

WEB_READY=false
for _ in {1..120}; do
  WEB_HEALTH="$(curl --max-time 2 -fsS http://localhost:3000/api/health 2>/dev/null || true)"
  if [[ "$WEB_HEALTH" == *'"app_version":"1.1.0-beta.21"'* ]]; then
    WEB_READY=true
    break
  fi
  sleep 0.5
done
if [[ "$WEB_READY" != true ]]; then
  echo "หน้าเว็บ Alpha เปิดไม่สำเร็จที่ http://localhost:3000"
  echo "ดู log: $ALPHA_DIR/work/alpha.log"
  exit 1
fi

echo "Alpha v1.1.0-beta.21 พร้อม: Ticket Bot Runtime มี Run ID · สถานะสด · Handoff · Stop; Full Loop ต้องยืนยันจาก run-report.jsonl ถึง PAYMENT_HANDOFF"
open "http://localhost:3000" >/dev/null 2>&1 || true
