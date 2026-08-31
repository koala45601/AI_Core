#!/usr/bin/env node

const baseUrl = String(process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11435").replace(/\/$/, "");
const defaultModels = [
  "alpha:9b",
];
const models = process.argv.slice(2).filter(Boolean).length ? process.argv.slice(2).filter(Boolean) : defaultModels;

async function ollama(path, body, timeout = 10 * 60_000) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`${path} ตอบกลับ ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return response.json();
}

function textOf(result) {
  return String(result?.message?.content || result?.message?.thinking || "").trim();
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

const cases = [
  {
    id: "thai_context",
    weight: 15,
    request: {
      messages: [
        { role: "system", content: "ตอบภาษาไทยตรงประเด็น ห้ามแต่งข้อมูล" },
        { role: "user", content: "จำไว้สำหรับคำถามถัดไป: ชื่อเล่นของฉันคือพี่ต้น และโปรเจกต์ชื่ออัลฟ่า" },
        { role: "assistant", content: "รับทราบครับ" },
        { role: "user", content: "ฉันชื่อเล่นอะไร และกำลังทำโปรเจกต์อะไร? ตอบหนึ่งประโยค" },
      ],
    },
    validate: (result) => /พี่ต้น/.test(textOf(result)) && /อัลฟ่า/.test(textOf(result)),
  },
  {
    id: "reasoning",
    weight: 15,
    request: {
      messages: [{ role: "user", content: "มีข้อมูลว่า: นักพัฒนาทุกคนในทีม A ใช้ Git และบางคนที่ใช้ Git ใช้ Docker เราสรุปได้หรือไม่ว่านักพัฒนาทุกคนในทีม A ใช้ Docker? ตอบสั้นพร้อมเหตุผล" }],
    },
    validate: (result) => /สรุปไม่ได้|ไม่สามารถสรุป|ไม่จำเป็น/.test(textOf(result)),
  },
  {
    id: "code_debugging",
    weight: 15,
    request: {
      messages: [{ role: "user", content: "แก้ JavaScript นี้ให้คืนผลรวม 6: `const sum = [1,2,3].reduce((a,b) => { a+b }, 0)` ตอบเฉพาะโค้ดหนึ่งบรรทัด" }],
    },
    validate: (result) => /reduce\s*\(\s*\(?(?:a|acc)\s*,\s*(?:b|n)/i.test(textOf(result)) && /(?:=>\s*(?:a|acc)\s*\+\s*(?:b|n)|return\s+(?:a|acc)\s*\+\s*(?:b|n))/i.test(textOf(result)),
  },
  {
    id: "strict_json",
    weight: 20,
    request: {
      format: "json",
      messages: [{ role: "user", content: "ตอบ JSON เท่านั้น รูปแบบ {\"intent\":\"web_read\",\"url\":\"...\"} สำหรับคำสั่ง: อ่านและสรุป https://example.com/docs" }],
    },
    validate: (result) => {
      const parsed = parseJson(textOf(result));
      return parsed?.intent === "web_read" && parsed?.url === "https://example.com/docs";
    },
  },
  {
    id: "tool_call",
    weight: 35,
    request: {
      messages: [{ role: "user", content: "ค้นข่าวล่าสุดเกี่ยวกับ Apple M4 แล้วสรุปพร้อมแหล่งอ้างอิง" }],
      tools: [{
        type: "function",
        function: {
          name: "web_search",
          description: "ค้นข้อมูลล่าสุดจากเว็บ",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        },
      }],
    },
    validate: (result) => {
      const calls = Array.isArray(result?.message?.tool_calls) ? result.message.tool_calls : [];
      const call = calls.find((item) => item?.function?.name === "web_search");
      const query = typeof call?.function?.arguments === "string" ? parseJson(call.function.arguments)?.query : call?.function?.arguments?.query;
      return typeof query === "string" && /apple|m4/i.test(query);
    },
  },
];

async function loadedMemory(model) {
  const response = await fetch(`${baseUrl}/api/ps`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) return 0;
  const payload = await response.json();
  const entry = (Array.isArray(payload.models) ? payload.models : []).find((item) => String(item.name || item.model || "").toLowerCase() === model.toLowerCase());
  return Number(entry?.size_vram || entry?.size || 0);
}

async function unload(model) {
  await ollama("/api/generate", { model, prompt: "", keep_alive: 0, stream: false }, 120_000).catch(() => {});
}

async function benchmark(model) {
  const result = { model, score: 0, total: cases.reduce((sum, item) => sum + item.weight, 0), elapsed_ms: 0, model_memory_bytes: 0, cases: [] };
  await unload(model);
  for (const item of cases) {
    const started = performance.now();
    try {
      const response = await ollama("/api/chat", {
        model,
        stream: false,
        think: false,
        keep_alive: "5m",
        options: { temperature: 0.1, num_ctx: 6144, num_predict: 512 },
        ...item.request,
      });
      const elapsed = Math.round(performance.now() - started);
      const passed = Boolean(item.validate(response));
      if (passed) result.score += item.weight;
      result.elapsed_ms += elapsed;
      result.cases.push({ id: item.id, passed, weight: item.weight, elapsed_ms: elapsed, eval_count: Number(response.eval_count || 0), response_preview: textOf(response).slice(0, 240), tool_calls: response?.message?.tool_calls || [] });
    } catch (error) {
      const elapsed = Math.round(performance.now() - started);
      result.elapsed_ms += elapsed;
      result.cases.push({ id: item.id, passed: false, weight: item.weight, elapsed_ms: elapsed, error: error instanceof Error ? error.message : String(error) });
    }
  }
  result.model_memory_bytes = await loadedMemory(model);
  await unload(model);
  return result;
}

const report = { generated_at: new Date().toISOString(), base_url: baseUrl, context_tokens: 6144, output_tokens: 512, results: [] };
for (const model of models) {
  process.stderr.write(`Benchmark ${model}...\n`);
  report.results.push(await benchmark(model));
}
report.recommendation = [...report.results].sort((left, right) => right.score - left.score || left.elapsed_ms - right.elapsed_ms)[0]?.model || "";
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
