import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd());
const text = (path) => fs.readFile(resolve(root, path), "utf8");

test("beta5 enables adaptive thinking without slowing trivial local chat", async () => {
  const [pkgText, patcher, launcher] = await Promise.all([
    text("package.json"),
    text("scripts/apply-beta5-adaptive-reasoning.mjs"),
    text("start-alpha-v11.command"),
  ]);

  assert.equal(JSON.parse(pkgText).version, "1.1.0-beta.5");
  assert.match(patcher, /alpha-beta5-adaptive-reasoning-v1/);
  assert.match(patcher, /purpose === \"tool\"/);
  assert.match(patcher, /think: true/);
  assert.match(patcher, /16_384/);
  assert.match(patcher, /24_576/);
  assert.match(patcher, /isFastLocalConversation/);
  assert.match(patcher, /tier: \"fast\", think: false/);
  assert.match(patcher, /designSkillGoal/);
  assert.match(patcher, /buildSkillAttempt/);
  assert.match(patcher, /synthesizeResearchRound/);
  assert.match(launcher, /apply-beta5-adaptive-reasoning\.mjs/);
});
