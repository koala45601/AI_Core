import json
import os
import pathlib
import re
import sys

data = json.loads(sys.argv[1])
text = str(data.get("text", "")).strip()
limit = max(1, min(20, int(data.get("max_sentences", 3) or 3)))
focus = {word.casefold() for word in re.findall(r"[\w\u0E00-\u0E7F]+", str(data.get("focus", "")))}
sentences = [part.strip() for part in re.split(r"(?<=[.!?。！？])\s+|\n+", text) if part.strip()]
if not sentences and text:
    sentences = [text]
if focus:
    ranked = sorted(enumerate(sentences), key=lambda item: (-len(focus & {word.casefold() for word in re.findall(r"[\w\u0E00-\u0E7F]+", item[1])}), item[0]))
    selected_indexes = sorted(index for index, _ in ranked[:limit])
    selected = [sentences[index] for index in selected_indexes]
else:
    selected = sentences[:limit]
result = {"summary": " ".join(selected), "sentence_count": len(selected), "source_sentence_count": len(sentences)}
pathlib.Path(os.environ["ALPHA_OUTPUT_DIR"], "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
