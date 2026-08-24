import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const route = await readFile(new URL("../app/api/chat/route.ts", import.meta.url), "utf8");
const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const postprocessRoute = await readFile(new URL("../app/api/chats/[id]/postprocess/route.ts", import.meta.url), "utf8");
const postprocess = await readFile(new URL("../lib/chat-postprocess.ts", import.meta.url), "utf8");
const ollama = await readFile(new URL("../lib/ollama.ts", import.meta.url), "utf8");
const patcher = await readFile(new URL("../scripts/apply-beta13-nonblocking-post-response.mjs", import.meta.url), "utf8");
const launcher = await readFile(new URL("../start-alpha-v11.command", import.meta.url), "utf8");

test("chat SSE completes before memory extraction or summarization", () => {
  assert.match(route, /alpha-beta13-nonblocking-post-response-v1/);
  assert.match(route, /controller\.enqueue\(event\("done", postprocess \? \{ postprocess \} : \{\}\)\)/);
  assert.doesNotMatch(route, /await extractDurableMemories|await summarizeChat|กำลังคัดเลือกสิ่งที่ควรจำ|กำลังย่อบริบท/);
});

test("idle post-processing is isolated behind its own cancellable endpoint", () => {
  assert.match(postprocessRoute, /postprocessChatTurn/);
  assert.match(postprocessRoute, /signal: request\.signal/);
  assert.match(postprocess, /userMessage\?\.chat_id|userMessage\.chat_id/);
  assert.match(postprocess, /assistantMessage\?\.chat_id|assistantMessage\.chat_id/);
  assert.match(postprocess, /extractDurableMemories/);
  assert.match(postprocess, /summarizeChat/);
  assert.match(ollama, /AbortSignal\.any\(\[signal, AbortSignal\.timeout\(180_000\)\]\)/);
});

test("a new question cancels pending utility work and keeps chat interactive", () => {
  assert.match(page, /cancelPendingChatPostprocess\(\)/);
  assert.match(page, /postprocessAbortRef\.current\?\.abort\(\)/);
  assert.match(page, /}, 8_000\)/);
  const runStart = page.indexOf("async function runChat(");
  const cancellation = page.indexOf("cancelPendingChatPostprocess();", runStart);
  const chatFetch = page.indexOf('fetch("/api/chat"', runStart);
  assert.ok(runStart >= 0 && cancellation > runStart && chatFetch > cancellation, "pending post-processing must be cancelled before a new chat request");
});

test("Beta13 runtime patch is versioned and applied after Beta12", () => {
  assert.match(patcher, /alpha-beta13-nonblocking-post-response-v1/);
  const beta12 = launcher.indexOf("apply-beta12-host-access-routing.mjs");
  const beta13 = launcher.indexOf("apply-beta13-nonblocking-post-response.mjs");
  assert.ok(beta12 >= 0 && beta13 > beta12);
  assert.match(launcher, /Alpha v1\.1\.0-beta\.(?:13|14|15|16|17)/);
});
