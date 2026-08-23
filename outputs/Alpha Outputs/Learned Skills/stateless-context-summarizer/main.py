import hashlib
import json
import os
import pathlib
import re
import sys

payload = json.loads(sys.argv[1])
messages = payload.get("messages") if isinstance(payload.get("messages"), list) else []
limit = max(0, min(50, int(payload.get("max_items", 6) or 0)))
important = re.compile(r"จำ|ต้องการ|ชอบ|โปรเจกต์|เป้าหมาย|แก้|error|bug|prefer|remember|goal", re.I)
unique = []
seen = set()
for index, item in enumerate(messages):
    if not isinstance(item, dict):
        continue
    content = " ".join(str(item.get("content", "")).split()).strip()
    if not content:
        continue
    digest = hashlib.sha256(content.casefold().encode("utf-8")).hexdigest()
    if digest in seen:
        continue
    seen.add(digest)
    unique.append({"index": index, "role": str(item.get("role", "unknown")), "content": content[:500], "important": bool(important.search(content))})
ranked = sorted(unique, key=lambda item: (not item["important"], -item["index"]))[:limit]
selected = sorted(ranked, key=lambda item: item["index"])
summary = "\n".join(f"- {item['role']}: {item['content']}" for item in selected)
result = {"summary": summary, "items": selected, "item_count": len(selected), "source_count": len(messages)}
pathlib.Path(os.environ["ALPHA_OUTPUT_DIR"], "summary.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({"item_count": len(selected), "source_count": len(messages), "summary": summary}, ensure_ascii=False, separators=(",", ":")))
