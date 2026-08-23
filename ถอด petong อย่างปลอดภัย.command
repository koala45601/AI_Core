#!/bin/zsh
set -euo pipefail

ALPHA_DIR="$(cd "$(dirname "$0")" && pwd)"
ALPHA_VOLUME_DEVICE="$(df -P "$ALPHA_DIR" | awk 'END { print $1 }')"
ALPHA_VOLUME="$(diskutil info "$ALPHA_VOLUME_DEVICE" 2>/dev/null | sed -n 's/^[[:space:]]*Mount Point:[[:space:]]*//p' | head -n 1)"

if [[ -z "$ALPHA_VOLUME" || "$ALPHA_VOLUME" != /Volumes/* ]]; then
  echo "ไม่พบ External HDD ที่เก็บอัลฟ่า"
  read -r "?กด Enter เพื่อปิดหน้าต่าง..."
  exit 1
fi

"$ALPHA_DIR/stop-alpha.command"
cd /tmp
echo "กำลังนำ External HDD ออกจากระบบอย่างปลอดภัย..."
if diskutil eject "$ALPHA_VOLUME"; then
  echo "ถอด petong ได้แล้ว"
else
  echo "ยังมีโปรแกรมอื่นใช้ petong อยู่ กรุณาปิดโปรแกรมนั้นแล้วลองใหม่"
fi
sleep 3
