#!/bin/zsh
set -euo pipefail

ALPHA_DIR="$(cd "$(dirname "$0")" && pwd)"
ALPHA_PID_FILE="$ALPHA_DIR/work/alpha.pid"
ALPHA_OLLAMA_PID_FILE="$ALPHA_DIR/work/ollama.pid"
ALPHA_TOOL_PID_FILE="$ALPHA_DIR/work/alpha-tool.pid"
ALPHA_OLLAMA_HOST="127.0.0.1:11435"
ALPHA_OLLAMA_URL="http://$ALPHA_OLLAMA_HOST"
ALPHA_OLLAMA_MODELS_DIR="$ALPHA_DIR/models/ollama"
ALPHA_WEB_SERVICE="com.alpha.local.web"
ALPHA_OLLAMA_SERVICE="com.alpha.local.ollama"
ALPHA_TOOL_SERVICE="com.alpha.local.tools"

stop_pid_tree() {
  local target_pid="$1"
  local child_pid

  for child_pid in $(pgrep -P "$target_pid" 2>/dev/null || true); do
    stop_pid_tree "$child_pid"
  done

  kill "$target_pid" 2>/dev/null || true
}

pid_belongs_to_alpha() {
  local target_pid="$1"
  local process_directory

  process_directory="$(lsof -a -p "$target_pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
  [[ "$process_directory" == "$ALPHA_DIR" ]]
}

launchctl remove "$ALPHA_WEB_SERVICE" >/dev/null 2>&1 || true

ALPHA_TOOL_TOKEN=""
if [[ -f "$ALPHA_DIR/.dev.vars" ]]; then
  ALPHA_TOOL_TOKEN="$(sed -n 's/^ALPHA_TOOL_TOKEN=//p' "$ALPHA_DIR/.dev.vars" | head -n 1 | tr -d '[:space:]')"
fi
if [[ -n "$ALPHA_TOOL_TOKEN" ]]; then
  curl -fsS -X POST -H "Authorization: Bearer $ALPHA_TOOL_TOKEN" -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:4317/v1/shutdown >/dev/null 2>&1 || true
fi
launchctl remove "$ALPHA_TOOL_SERVICE" >/dev/null 2>&1 || true

for _ in {1..20}; do
  if ! lsof -nP -iTCP:4317 -sTCP:LISTEN >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

if [[ -f "$ALPHA_TOOL_PID_FILE" ]]; then
  ALPHA_TOOL_PID="$(<"$ALPHA_TOOL_PID_FILE")"
  if pid_belongs_to_alpha "$ALPHA_TOOL_PID"; then
    stop_pid_tree "$ALPHA_TOOL_PID"
  fi
  rm -f "$ALPHA_TOOL_PID_FILE"
fi

# เก็บเฉพาะ Alpha Browser ที่ใช้โปรไฟล์แยก ในกรณี Tool Service ปิดผิดปกติ
for ALPHA_BROWSER_PID in $(pgrep -f "$ALPHA_DIR/work/alpha-browser-profile" 2>/dev/null || true); do
  stop_pid_tree "$ALPHA_BROWSER_PID"
done

# SearXNG เป็น container ของอัลฟ่าโดยเฉพาะ ปิดได้โดยไม่แตะ container อื่นหรือ Docker Desktop
if [[ -x /usr/local/bin/docker ]] && /usr/local/bin/docker info >/dev/null 2>&1; then
  ALPHA_SKILL_CONTAINERS=("${(@f)$(/usr/local/bin/docker ps -aq --filter label=alpha.skill-lab=true 2>/dev/null)}")
  if (( ${#ALPHA_SKILL_CONTAINERS[@]} )); then
    /usr/local/bin/docker rm -f "${ALPHA_SKILL_CONTAINERS[@]}" >/dev/null 2>&1 || true
  fi
  /usr/local/bin/docker compose -f "$ALPHA_DIR/infra/searxng/docker-compose.yml" down --remove-orphans >/dev/null 2>&1 || true
  /usr/local/bin/docker rm -f alpha-searxng >/dev/null 2>&1 || true
fi

if [[ -f "$ALPHA_PID_FILE" ]]; then
  ALPHA_SERVER_PID="$(<"$ALPHA_PID_FILE")"
  if pid_belongs_to_alpha "$ALPHA_SERVER_PID"; then
    stop_pid_tree "$ALPHA_SERVER_PID"
  fi
  rm -f "$ALPHA_PID_FILE"
fi

# กรณีเซิร์ฟเวอร์ถูกเปิดจาก Terminal หรือ Codex โดยไม่มีไฟล์ PID
while IFS= read -r ALPHA_PORT_PID; do
  [[ -z "$ALPHA_PORT_PID" ]] && continue
  ALPHA_PORT_COMMAND="$(ps -p "$ALPHA_PORT_PID" -o command= 2>/dev/null || true)"
  if [[ "$ALPHA_PORT_COMMAND" == *"$ALPHA_DIR"* ]]; then
    stop_pid_tree "$ALPHA_PORT_PID"
  fi
done < <(lsof -nP -iTCP:3000 -sTCP:LISTEN -t 2>/dev/null || true)

if command -v ollama >/dev/null 2>&1; then
  ALPHA_OLLAMA_BIN="$(command -v ollama)"
elif [[ -x "/opt/homebrew/bin/ollama" ]]; then
  ALPHA_OLLAMA_BIN="/opt/homebrew/bin/ollama"
else
  ALPHA_OLLAMA_BIN=""
fi

export OLLAMA_HOST="$ALPHA_OLLAMA_HOST"
export OLLAMA_MODELS="$ALPHA_OLLAMA_MODELS_DIR"
if curl -fsS "$ALPHA_OLLAMA_URL/api/tags" >/dev/null 2>&1; then
  if [[ -n "$ALPHA_OLLAMA_BIN" ]]; then
    "$ALPHA_OLLAMA_BIN" stop qwen3:4b-instruct >/dev/null 2>&1 || true
    "$ALPHA_OLLAMA_BIN" stop qwen3.5:9b >/dev/null 2>&1 || true
  fi
fi

launchctl remove "$ALPHA_OLLAMA_SERVICE" >/dev/null 2>&1 || true

if [[ -f "$ALPHA_OLLAMA_PID_FILE" ]]; then
  ALPHA_OLLAMA_SERVER_PID="$(<"$ALPHA_OLLAMA_PID_FILE")"
  ALPHA_OLLAMA_SERVER_COMMAND="$(ps -p "$ALPHA_OLLAMA_SERVER_PID" -o command= 2>/dev/null || true)"
  if [[ "$ALPHA_OLLAMA_SERVER_COMMAND" == *"ollama serve"* ]]; then
    stop_pid_tree "$ALPHA_OLLAMA_SERVER_PID"
  fi
  rm -f "$ALPHA_OLLAMA_PID_FILE"
fi

for _ in {1..30}; do
  if ! curl -fsS "$ALPHA_OLLAMA_URL/api/tags" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

echo "ปิดอัลฟ่า Tool Service เบราว์เซอร์ SearXNG เว็บเซิร์ฟเวอร์ โมเดล และ Ollama แล้ว"
echo "ตอนนี้อัลฟ่าไม่ทำงานเบื้องหลังและคืน RAM แล้ว"
sleep 2
