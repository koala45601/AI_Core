import base64
import json
import os
import pathlib
import struct
import sys

payload = json.loads(sys.argv[1])
raw = base64.b64decode(str(payload.get("png_base64", "")), validate=True)
if len(raw) < 24 or raw[:8] != b"\x89PNG\r\n\x1a\n" or raw[12:16] != b"IHDR":
    raise ValueError("input is not a valid PNG header")
width, height = struct.unpack(">II", raw[16:24])
texts = []
position = 8
while position + 12 <= len(raw):
    length = struct.unpack(">I", raw[position:position + 4])[0]
    chunk_type = raw[position + 4:position + 8]
    chunk_data = raw[position + 8:position + 8 + length]
    if len(chunk_data) != length:
        break
    if chunk_type == b"tEXt" and b"\0" in chunk_data:
        key, value = chunk_data.split(b"\0", 1)
        texts.append({"key": key.decode("latin-1", "replace"), "value": value.decode("latin-1", "replace")})
    position += 12 + length
filename = str(payload.get("filename", "image.png"))
caption = f"{filename}: PNG {width}x{height}"
if texts:
    caption += " — " + "; ".join(item["value"] for item in texts[:3])
result = {"filename": filename, "format": "PNG", "width": width, "height": height, "caption": caption, "embedded_text": texts}
pathlib.Path(os.environ["ALPHA_OUTPUT_DIR"], "metadata.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
