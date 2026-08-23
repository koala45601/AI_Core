import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const patcher = await readFile(new URL("../scripts/apply-beta10-persistent-search.mjs", import.meta.url), "utf8");

test("beta10 decouples SearXNG from generic idle cleanup", () => {
  assert.match(patcher, /Search service lifetime is the Alpha session/);
  assert.match(patcher, /if \(alphaContext\) await alphaContext\.close/);
  assert.doesNotMatch(patcher, /lastHeavyUse = 0;\n    await stopHeavyTools\(\)\.catch/);
});

test("beta10 starts and keeps SearXNG alive while Tool Service runs", () => {
  assert.match(patcher, /void keepSearxngAlive\(\);/);
  assert.match(patcher, /setInterval\(\(\) => \{ void keepSearxngAlive\(\); \}, 30_000\)/);
  assert.match(patcher, /await ensureSearxng\(\)/);
  assert.match(patcher, /searxngKeepAliveBusy/);
});

test("beta10 keeps real user activity tracking separate from keepalive", () => {
  assert.match(patcher, /async function searchWeb\(query\) \{\n  lastHeavyUse = Date\.now\(\);/);
  assert.match(patcher, /async function ensureSearxng\(\) \{\n  if \(!await refreshStorageState\(\)\)/);
});

test("explicit shutdown path remains untouched", () => {
  assert.doesNotMatch(patcher, /function stopHeavyTools[\s\S]*replaceOnce/);
});
