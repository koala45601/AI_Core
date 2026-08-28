import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(process.cwd());

async function text(path) {
  return fs.readFile(resolve(root, path), "utf8");
}

test("beta3 source contracts keep approvals persistent and resumable", async () => {
  const [pkg, wrapper, start, confirm, patcher] = await Promise.all([
    text("package.json"),
    text("tool-service/server-wrapper-beta3.mjs"),
    text("start-alpha-v11.command"),
    text("app/api/tools/confirm/route.ts"),
    text("scripts/apply-beta3-runtime-patch.mjs"),
  ]);
  assert.match(JSON.parse(pkg).version, /^(?:1\.1\.0-beta\.\d+|2\.0\.0-alpha\.\d+)$/);
  assert.match(wrapper, /host-tool-confirmations\.json/);
  assert.match(wrapper, /24 \* 60 \* 60 \* 1000/);
  assert.match(wrapper, /HOMEBREW_NO_AUTO_UPDATE/);
  assert.match(wrapper, /resume:\s*true/);
  assert.match(wrapper, /approval_store:\s*"persistent"/);
  assert.match(start, /server-wrapper-beta3\.mjs/);
  assert.match(start, /recover-beta3-approvals\.mjs/);
  assert.match(confirm, /permission_resolved/);
  assert.match(patcher, /alpha-beta3-resume-v1/);
  assert.match(patcher, /runChat\(resumePrompt, false, false, messageId, previousUser\.id\)/);
});

test("restart recovery converts interrupted approvals back to pending", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alpha-beta3-recovery-"));
  const work = join(dir, "work");
  await fs.mkdir(work, { recursive: true });
  const file = join(work, "host-tool-confirmations.json");
  await fs.writeFile(file, JSON.stringify({
    version: 1,
    records: [
      { id: "a", type: "install_package", status: "running", createdAt: 1, updatedAt: 2 },
      { id: "b", type: "install_package", status: "completed", createdAt: 1, updatedAt: 2 },
    ],
  }), "utf8");

  const run = spawnSync(process.execPath, [resolve(root, "scripts/recover-beta3-approvals.mjs"), dir], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(saved.records.find((item) => item.id === "a").status, "pending");
  assert.equal(saved.records.find((item) => item.id === "a").recoveredAfterRestart, true);
  assert.equal(saved.records.find((item) => item.id === "b").status, "completed");
});

test("UI runtime patch is idempotent and restores permission state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alpha-beta3-ui-"));
  const app = join(dir, "app");
  await fs.mkdir(app, { recursive: true });
  const page = join(app, "page.tsx");
  const fixture = `
const response = { json: async () => ({}) } as any;
const messages: any[] = [];
const activeChatId = "chat";
const isThinking = false;
const loadHealth = () => {};
const setMessages = (_x: any) => {};
const setIsThinking = (_x: any) => {};
const setThinkingSteps = (_x: any) => {};
async function runChat(..._args: any[]) {}
async function loadChat() {
      const data = await response.json() as {
        messages: Array<{ id: string; role: "user" | "assistant"; content: string; metadata?: { sources?: SearchResult[]; artifacts?: ArtifactRecord[]; error?: boolean } }>;
      };
      setMessages(data.messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        sources: message.metadata?.sources,
        artifacts: message.metadata?.artifacts,
        error: message.metadata?.error,
      })));
}
  async function confirmPermission(messageId: string, confirmationId: string, approved: boolean) {
    return { messageId, confirmationId, approved };
  }

  async function openArtifact(id: string) { return id; }
`;
  await fs.writeFile(page, fixture, "utf8");
  const patcher = resolve(root, "scripts/apply-beta3-runtime-patch.mjs");
  const first = spawnSync(process.execPath, [patcher, dir], { encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  const once = await fs.readFile(page, "utf8");
  assert.match(once, /alpha-beta3-resume-v1/);
  assert.match(once, /tool_events\?: Array<Record<string, unknown>>/);
  assert.match(once, /permissionEvent/);
  assert.match(once, /result\.resume === true/);
  const second = spawnSync(process.execPath, [patcher, dir], { encoding: "utf8" });
  assert.equal(second.status, 0, second.stderr);
  const twice = await fs.readFile(page, "utf8");
  assert.equal(twice, once);
});
