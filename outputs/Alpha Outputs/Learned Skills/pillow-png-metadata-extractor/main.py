import base64
import io
import json
import os
import pathlib
import sys
from PIL import Image

payload = json.loads(sys.argv[1])
raw = base64.b64decode(str(payload.get("png_base64", "")), validate=True)
with Image.open(io.BytesIO(raw)) as image:
    image.load()
    result = {
        "filename": str(payload.get("filename", "image.png")),
        "format": str(image.format or "").upper(),
        "width": image.width,
        "height": image.height,
        "mode": image.mode,
        "animated": bool(getattr(image, "is_animated", False)),
    }
if result["format"] != "PNG":
    raise ValueError("only PNG is accepted")
pathlib.Path(os.environ["ALPHA_OUTPUT_DIR"], "metadata.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
