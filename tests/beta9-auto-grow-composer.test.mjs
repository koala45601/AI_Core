import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const patcher = await readFile(new URL("../scripts/apply-beta9-auto-grow-composer.mjs", import.meta.url), "utf8");

test("beta9 auto-grows the main composer from scrollHeight", () => {
  assert.match(patcher, /composerInputRef/);
  assert.match(patcher, /textarea\.scrollHeight/);
  assert.match(patcher, /\[draft\]/);
  assert.match(patcher, /Math\.min\(320/);
});

test("beta9 keeps long prompts inside a viewport-aware cap", () => {
  assert.match(patcher, /max-height: min\(35vh, 320px\)/);
  assert.match(patcher, /overflowY = textarea\.scrollHeight > viewportCap \? \\"auto\\" : \\"hidden\\"/);
});

test("beta9 only patches the main composer textarea", () => {
  assert.match(patcher, /<textarea ref=\{composerInputRef\} value=\{draft\}/);
  assert.doesNotMatch(patcher, /correctionDraft.*composerInputRef/);
});
