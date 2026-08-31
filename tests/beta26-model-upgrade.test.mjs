import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("9B is the only selectable and downloadable model", async () => {
  const [types, page, launcher] = await Promise.all([
    source("lib/types.ts"),
    source("app/page.tsx"),
    source("start-alpha.command"),
  ]);
  assert.doesNotMatch(types, /Qwen3-14B|qwen3:4b-instruct/);
  assert.match(types, /model: "qwen3\.5:9b"/);
  assert.match(page, /Qwen3\.5 9B/);
  assert.doesNotMatch(page, /Qwen3 14B|Qwen3 4B/);
  assert.doesNotMatch(launcher, /qwen3:4b-instruct|Qwen3-14B/);
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

test("9B chat and tool planning use the configured 8192-token context and stay resident", async () => {
  const ollama = await source("lib/ollama.ts");
  assert.doesNotMatch(ollama, /largeLocalModel|24_576|16_384/);
  assert.match(ollama, /Math\.min\(8192, Math\.max\(4096/);
  assert.match(ollama, /keep_alive: -1/);
  assert.doesNotMatch(ollama, /keep_alive: "5m"/);
});
