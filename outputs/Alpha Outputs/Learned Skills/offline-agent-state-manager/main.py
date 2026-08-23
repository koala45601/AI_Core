import copy
import json
import os
import pathlib
import sys

data = json.loads(sys.argv[1])
state = copy.deepcopy(data.get("state") if isinstance(data.get("state"), dict) else {})
operations = data.get("operations")
if not isinstance(operations, list):
    operations = [data.get("operation", {})]
for operation in operations:
    if not isinstance(operation, dict):
        continue
    action = str(operation.get("action", "set"))
    key = str(operation.get("key", "")).strip()
    if not key:
        continue
    if action == "delete":
        state.pop(key, None)
    elif action == "increment":
        state[key] = float(state.get(key, 0)) + float(operation.get("delta", 1))
        if state[key].is_integer():
            state[key] = int(state[key])
    else:
        state[key] = operation.get("value")
result = {"ok": True, "state": state, "operation_count": len(operations)}
pathlib.Path(os.environ["ALPHA_OUTPUT_DIR"], "state.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
