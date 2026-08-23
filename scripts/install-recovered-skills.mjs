import { promises as fs } from "node:fs";
import { deflateSync } from "node:zlib";
import { resolve } from "node:path";

const appDir = resolve(process.cwd());
const vars = await fs.readFile(resolve(appDir, ".dev.vars"), "utf8");
const token = vars.match(/^ALPHA_TOOL_TOKEN=(.+)$/m)?.[1]?.trim();
const baseUrl = vars.match(/^ALPHA_TOOL_BASE_URL=(.+)$/m)?.[1]?.trim() || "http://127.0.0.1:4317";

if (!token || token.length < 32) throw new Error("ALPHA_TOOL_TOKEN ไม่พร้อมใช้งาน");

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const name = Buffer.from(type, "ascii");
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, checksum]);
}

function makePng(width, height, text = "") {
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = [];
  for (let row = 0; row < height; row += 1) rows.push(Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 4, 0xff)]));
  const chunks = [pngChunk("IHDR", ihdr)];
  if (text) chunks.push(pngChunk("tEXt", Buffer.from(`Description\0${text}`, "utf8")));
  chunks.push(pngChunk("IDAT", deflateSync(Buffer.concat(rows))), pngChunk("IEND"));
  return Buffer.concat([signature, ...chunks]).toString("base64");
}

const pythonConcise = String.raw`import json
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
`;

const pythonState = String.raw`import copy
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
`;

const pythonPngParser = String.raw`import base64
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
`;

const pythonRuleEvaluator = String.raw`import json
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
`;

const pythonPillow = String.raw`import base64
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
`;

const pythonSummarizer = String.raw`import hashlib
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
`;

const pngFixtures = Array.from({ length: 24 }, (_, index) => ({
  width: (index % 6) + 1,
  height: (index % 4) + 1,
  png_base64: makePng((index % 6) + 1, (index % 4) + 1, `fixture-${index + 1}`),
}));

const standardHidden = pngFixtures.slice(4).map((fixture, index) => ({
  name: `hidden-png-${index + 1}`,
  input: { png_base64: fixture.png_base64, filename: `hidden-${index + 1}.png` },
  stdout_contains: `\"width\":${fixture.width}`,
  expected_files: ["metadata.json"],
}));

const pillowHidden = pngFixtures.slice(4).map((fixture, index) => ({
  name: `hidden-pillow-${index + 1}`,
  input: { png_base64: fixture.png_base64, filename: `ภาพ-${index + 1}.png` },
  stdout_contains: `\"height\":${fixture.height}`,
  expected_files: ["metadata.json"],
}));

const skills = [
  {
    objective: "สังเคราะห์ข้อความหรือประวัติสนทนายาวให้เป็นคำตอบกระชับ โดยรักษาลำดับและหัวข้อที่ผู้ใช้ระบุ",
    success_criteria: "จำกัดจำนวนประโยคได้ รองรับภาษาไทยและอังกฤษ และสร้าง result.json อย่างสม่ำเสมอ",
    verification_scope: "4 visible fixtures และ 20 hidden fixtures ครอบคลุมไทย อังกฤษ บรรทัดใหม่ focus และขีดจำกัดจำนวนประโยค",
    skill: {
      id: "context-aware-concise-synthesizer", name: "Context-Aware Concise Response Synthesizer",
      description: "ย่อข้อความยาวให้กระชับตามจำนวนประโยคและ focus ที่กำหนด โดยทำงานออฟไลน์",
      runtime: "python", entrypoint: "main.py", dependencies: ["python-stdlib"],
      trigger_examples: ["สรุปให้สั้น", "ตอบแบบกระชับ", "ย่อบริบทนี้"],
      test_cases: [
        { name: "thai-two", input: { text: "หนึ่งประโยคแรก。 สองประโยคถัดไป。 สามประโยคสุดท้าย。", max_sentences: 2 }, stdout_contains: "\"sentence_count\":2", expected_files: ["result.json"] },
        { name: "english-one", input: { text: "First. Second. Third.", max_sentences: 1 }, stdout_contains: "\"sentence_count\":1", expected_files: ["result.json"] },
        { name: "focus", input: { text: "อาหารอร่อย。 Python แก้บั๊กได้。 วันนี้อากาศดี。", max_sentences: 1, focus: "Python" }, stdout_contains: "Python", expected_files: ["result.json"] },
        { name: "empty", input: { text: "", max_sentences: 3 }, stdout_contains: "\"sentence_count\":0", expected_files: ["result.json"] },
      ],
    },
    hidden_test_cases: Array.from({ length: 20 }, (_, index) => ({ name: `hidden-${index + 1}`, input: { text: `ข้อความ ${index + 1}。 ข้อมูลเสริม ${index + 1}。`, max_sentences: (index % 2) + 1 }, stdout_contains: `\"sentence_count\":${(index % 2) + 1}`, expected_files: ["result.json"] })),
    source: pythonConcise,
  },
  {
    objective: "จัดการ state ของ agent แบบออฟไลน์ด้วยคำสั่ง set, increment และ delete โดยไม่แก้ object ต้นฉบับ",
    success_criteria: "คืน state ใหม่แบบ deterministic รองรับภาษาไทยและสร้าง state.json",
    verification_scope: "4 visible fixtures และ 20 hidden state transitions ครอบคลุม set, increment, delete, Unicode และหลาย operation",
    skill: {
      id: "offline-agent-state-manager", name: "Robust Offline State Management for Text-Based Agents",
      description: "อัปเดต state ของ agent แบบ deterministic และออฟไลน์ รองรับ set, increment, delete และ batch operations",
      runtime: "python", entrypoint: "main.py", dependencies: ["python-stdlib"],
      trigger_examples: ["อัปเดต state", "จำสถานะงาน", "เพิ่มตัวนับแบบออฟไลน์"],
      test_cases: [
        { name: "increment", input: { state: { count: 3 }, operation: { action: "increment", key: "count", delta: 2 } }, stdout_contains: "\"count\":5", expected_files: ["state.json"] },
        { name: "set-thai", input: { state: {}, operation: { action: "set", key: "ภาษา", value: "ไทย" } }, stdout_contains: "ไทย", expected_files: ["state.json"] },
        { name: "delete", input: { state: { keep: 1, remove: 2 }, operation: { action: "delete", key: "remove" } }, stdout_contains: "\"keep\":1", expected_files: ["state.json"] },
        { name: "batch", input: { state: { n: 1 }, operations: [{ action: "increment", key: "n", delta: 4 }, { action: "set", key: "done", value: true }] }, stdout_contains: "\"n\":5", expected_files: ["state.json"] },
      ],
    },
    hidden_test_cases: Array.from({ length: 20 }, (_, index) => ({ name: `hidden-${index + 1}`, input: { state: { count: index }, operation: { action: "increment", key: "count", delta: 1 } }, stdout_contains: `\"count\":${index + 1}`, expected_files: ["state.json"] })),
    source: pythonState,
  },
  {
    objective: "อ่าน PNG แบบออฟไลน์ด้วย Python standard library เพื่อดึงขนาด ข้อความ metadata และสร้าง caption สั้น",
    success_criteria: "ตรวจ signature/IHDR ได้ ดึง tEXt chunk ได้ และสร้าง metadata.json โดยไม่ใช้เน็ตหรือ dependency ภายนอก",
    verification_scope: "4 visible fixtures และ 20 hidden PNG fixtures หลายขนาด ชื่อไฟล์ Unicode และ tEXt metadata; ไม่อ้างว่าเป็น OCR พิกเซล",
    skill: {
      id: "offline-png-parser-captioner", name: "Offline PNG Image Parser & Captioner (Standard Library)",
      description: "อ่านโครงสร้าง PNG, ขนาด และ embedded text ด้วย standard library แล้วสร้าง caption แบบออฟไลน์",
      runtime: "python", entrypoint: "main.py", dependencies: ["python-stdlib"],
      trigger_examples: ["อ่าน metadata PNG", "บอกขนาดรูป PNG แบบออฟไลน์", "สร้าง caption จาก PNG"],
      test_cases: pngFixtures.slice(0, 4).map((fixture, index) => ({ name: `visible-png-${index + 1}`, input: { png_base64: fixture.png_base64, filename: `fixture-${index + 1}.png` }, stdout_contains: `\"width\":${fixture.width}`, expected_files: ["metadata.json"] })),
    },
    hidden_test_cases: standardHidden,
    source: pythonPngParser,
  },
  {
    objective: "ประเมินคำขอตามกฎที่ผู้ใช้กำหนดใน Settings เท่านั้น โดยค่าเริ่มต้นเป็น allow และไม่มี blocked term ฝังในโค้ด",
    success_criteria: "รองรับ allow, block, warn, แสดงกฎที่ตรงกัน และไม่ปฏิเสธเมื่อ rules ว่าง",
    verification_scope: "4 visible fixtures และ 20 hidden fixtures ครอบคลุม default allow, explicit block/warn/allow, Unicode และลำดับกฎ",
    skill: {
      id: "configurable-rule-evaluator", name: "Adaptive Constraint Enforcement via User-Configured Rules",
      description: "ตัวประเมินกฎแบบ allow-by-default ซึ่งบังคับเฉพาะ rules ที่ผู้ใช้ส่งมา ไม่มีข้อห้าม hardcode",
      runtime: "python", entrypoint: "main.py", dependencies: ["python-stdlib"],
      trigger_examples: ["ตรวจตามกฎใน Settings", "ประเมิน blocked terms", "ใช้กฎที่ฉันกำหนด"],
      test_cases: [
        { name: "empty-rules-allow", input: { request: "หัวข้อใดก็ได้", rules: [] }, stdout_contains: "\"decision\":\"allow\"", expected_files: ["decision.json"] },
        { name: "explicit-block", input: { request: "ห้ามคำนี้", rules: [{ term: "ห้ามคำนี้", action: "block", reason: "ผู้ใช้บล็อกเอง" }] }, stdout_contains: "\"decision\":\"block\"", expected_files: ["decision.json"] },
        { name: "explicit-warn", input: { request: "หัวข้อเตือน", rules: [{ term: "เตือน", action: "warn" }] }, stdout_contains: "\"decision\":\"warn\"", expected_files: ["decision.json"] },
        { name: "default-warn", input: { request: "ไม่ตรง", rules: [], default_action: "warn" }, stdout_contains: "\"decision\":\"warn\"", expected_files: ["decision.json"] },
      ],
    },
    hidden_test_cases: Array.from({ length: 20 }, (_, index) => {
      const blocked = index % 2 === 0;
      return { name: `hidden-${index + 1}`, input: { request: `คำขอ-${index}`, rules: blocked ? [{ term: `คำขอ-${index}`, action: "block" }] : [] }, stdout_contains: `\"decision\":\"${blocked ? "block" : "allow"}\"`, expected_files: ["decision.json"] };
    }),
    source: pythonRuleEvaluator,
  },
  {
    objective: "อ่าน metadata ของ PNG ด้วย Pillow แบบออฟไลน์และคืนชื่อไฟล์ format ขนาด mode และ animated flag",
    success_criteria: "เปิด PNG จริงหลายขนาดและ Unicode filename ได้ สร้าง metadata.json และไม่ใช้ network ระหว่างทำงาน",
    verification_scope: "4 visible fixtures และ 20 hidden valid PNG fixtures หลายขนาด/ชื่อ Unicode บน Pillow 11.3.0",
    skill: {
      id: "pillow-png-metadata-extractor", name: "PNG Metadata Extraction with Pillow (Fallback)",
      description: "ดึง metadata PNG ด้วย Pillow ใน Docker แบบปิดเครือข่าย พร้อมผลลัพธ์ JSON",
      runtime: "python", entrypoint: "main.py", dependencies: ["python-pillow"],
      trigger_examples: ["อ่านขนาด PNG ด้วย Pillow", "ตรวจ mode ของรูป", "ดึง metadata รูป PNG"],
      test_cases: pngFixtures.slice(0, 4).map((fixture, index) => ({ name: `visible-pillow-${index + 1}`, input: { png_base64: fixture.png_base64, filename: `fixture-${index + 1}.png` }, stdout_contains: `\"width\":${fixture.width}`, expected_files: ["metadata.json"] })),
    },
    hidden_test_cases: pillowHidden,
    source: pythonPillow,
  },
  {
    objective: "สรุป conversation history แบบ stateless โดยเก็บข้อความสำคัญ ตัดรายการซ้ำ และจำกัดจำนวนรายการ",
    success_criteria: "รองรับภาษาไทย/อังกฤษ ข้อมูลว่าง ข้อความซ้ำ และสร้าง summary.json แบบ deterministic",
    verification_scope: "4 visible fixtures และ 20 hidden conversation fixtures ครอบคลุมความสำคัญ duplicate, empty, Unicode และ context limit",
    skill: {
      id: "stateless-context-summarizer", name: "Resilient Context Summarization for Stateless Agents",
      description: "บีบอัดประวัติแชตแบบ deterministic ให้เหลือรายการสำคัญสำหรับ context ถัดไป โดยทำงานออฟไลน์",
      runtime: "python", entrypoint: "main.py", dependencies: ["python-stdlib"],
      trigger_examples: ["สรุปประวัติแชต", "บีบอัด context", "เก็บเฉพาะข้อมูลสำคัญ"],
      test_cases: [
        { name: "two-items", input: { messages: [{ role: "user", content: "ฉันชอบภาษาไทย" }, { role: "assistant", content: "รับทราบ" }], max_items: 2 }, stdout_contains: "\"item_count\":2", expected_files: ["summary.json"] },
        { name: "empty", input: { messages: [], max_items: 3 }, stdout_contains: "\"item_count\":0", expected_files: ["summary.json"] },
        { name: "deduplicate", input: { messages: [{ role: "user", content: "เป้าหมายเดิม" }, { role: "user", content: "เป้าหมายเดิม" }], max_items: 5 }, stdout_contains: "\"item_count\":1", expected_files: ["summary.json"] },
        { name: "limit", input: { messages: [{ role: "user", content: "หนึ่ง" }, { role: "user", content: "สอง" }, { role: "user", content: "สาม" }], max_items: 1 }, stdout_contains: "\"item_count\":1", expected_files: ["summary.json"] },
      ],
    },
    hidden_test_cases: Array.from({ length: 20 }, (_, index) => ({ name: `hidden-${index + 1}`, input: { messages: [{ role: "user", content: `เป้าหมาย ${index}` }, { role: "assistant", content: `ผลลัพธ์ ${index}` }], max_items: 2 }, stdout_contains: "\"item_count\":2", expected_files: ["summary.json"] })),
    source: pythonSummarizer,
  },
];

async function api(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(options.headers || {}) },
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  const data = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) throw new Error(`${path}: ${data.error || JSON.stringify(data)}`);
  return data;
}

const health = await api("/v1/health");
if (!health.docker_connected) throw new Error("Docker ยังไม่พร้อม จึงทดสอบ Skill Lab ไม่ได้");

for (let index = 0; index < skills.length; index += 1) {
  const item = skills[index];
  process.stdout.write(`[${index + 1}/${skills.length}] ${item.skill.name} ... `);
  const result = await api("/v1/tool/execute", {
    method: "POST",
    body: JSON.stringify({
      name: "skill_lab_test",
      arguments: {
        run_id: `alpha-1-recovery-${item.skill.id}`,
        goal_id: item.skill.id,
        objective: item.objective,
        success_criteria: item.success_criteria,
        attempt: 1,
        origin: "auto_learn",
        skill: item.skill,
        files: [{ path: "main.py", content: item.source }],
        hidden_test_cases: item.hidden_test_cases,
        verification_scope: item.verification_scope,
        cleanup_run: true,
      },
      settings: { tool_idle_timeout_seconds: 300 },
    }),
  });
  if (!result.passed || result.skill?.verification_status !== "verified") {
    process.stdout.write("FAILED\n");
    throw new Error(`${item.skill.id}: ${result.reason || "verification failed"}`);
  }
  process.stdout.write(`PASS (${result.skill.verified_passed}/${result.skill.verified_total} visible, ${result.skill.hidden_test_result.passed}/${result.skill.hidden_test_result.total} hidden)\n`);
}

const registry = await api("/v1/skills?limit=100&sort=name");
const installed = new Set(registry.skills.map((skill) => skill.id));
const missing = skills.map((item) => item.skill.id).filter((id) => !installed.has(id));
if (missing.length) throw new Error(`ติดตั้งไม่ครบ: ${missing.join(", ")}`);

console.log(`ติดตั้งสำเร็จ ${skills.length}/${skills.length} สกิล; registry มีทั้งหมด ${registry.total} สกิล`);
