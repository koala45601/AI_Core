import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("14B abliterated remains optional while benchmarked 9B stays the default", async () => {
  const [types, page, launcher] = await Promise.all([
    source("lib/types.ts"),
    source("app/page.tsx"),
    source("start-alpha.command"),
  ]);
  const model = "hf.co/RootMonsteR/Qwen3-14B-Abliterated-GGUF:Q4_K_M";
  assert.match(types, new RegExp(model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(types, /model: "qwen3\.5:9b"/);
  assert.match(page, /Qwen3 14B Abliterated Q4/);
  assert.match(page, /benchmark 85\/100 เท่ากับ 14B/);
  assert.doesNotMatch(launcher, /ALPHA_14B_MODEL/);
});

test("model benchmark measures Thai context, reasoning, code, JSON and real tool calling", async () => {
  const benchmark = await source("scripts/benchmark-alpha-models.mjs");
  for (const id of ["thai_context", "reasoning", "code_debugging", "strict_json", "tool_call"]) assert.match(benchmark, new RegExp(id));
  assert.match(benchmark, /\/api\/chat/);
  assert.match(benchmark, /\/api\/ps/);
  assert.match(benchmark, /web_search/);
  assert.match(benchmark, /think: false/);
  assert.match(benchmark, /recommendation/);
});

test("14B chat and tool planning cap context at 6144 and avoid the empty thinking-only response", async () => {
  const ollama = await source("lib/ollama.ts");
  assert.match(ollama, /largeLocalModel/);
  assert.match(ollama, /Math\.min\(6144, configuredCtx\)/);
  assert.match(ollama, /think: !largeLocalModel/);
});
