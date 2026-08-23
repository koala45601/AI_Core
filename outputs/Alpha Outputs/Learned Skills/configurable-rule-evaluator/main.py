import json
import os
import pathlib
import sys

payload = json.loads(sys.argv[1])
request = str(payload.get("request", ""))
normalized = request.casefold()
default_action = str(payload.get("default_action", "allow")).casefold()
if default_action not in {"allow", "block", "warn"}:
    default_action = "allow"
decision = default_action
matched_rule = None
reason = "ไม่มีกฎที่ตรงกัน จึงใช้ค่าเริ่มต้นจากผู้ใช้"
for index, rule in enumerate(payload.get("rules", [])):
    if not isinstance(rule, dict):
        continue
    term = str(rule.get("term", "")).strip()
    action = str(rule.get("action", "allow")).casefold()
    if term and term.casefold() in normalized and action in {"allow", "block", "warn"}:
        decision = action
        matched_rule = index
        reason = str(rule.get("reason") or f"ตรงกับกฎคำว่า {term}")
        break
result = {"decision": decision, "matched_rule": matched_rule, "reason": reason, "default_action": default_action}
pathlib.Path(os.environ["ALPHA_OUTPUT_DIR"], "decision.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
