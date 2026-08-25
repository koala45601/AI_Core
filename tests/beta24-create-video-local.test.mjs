import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd());

async function read(path) {
  return fs.readFile(resolve(root, path), "utf8");
}

test("beta24 adds a local-only Wan video worker and async run manager", async () => {
  const manager = await read("tool-service/video-run-manager.mjs");
  const worker = await read("tool-service/create-video-worker.mjs");
  assert.match(manager, /wan2\.1-mac-1\.3b/);
  assert.match(manager, /paid_api_required: false/);
  assert.match(manager, /LOAD_WORK_SAVE_UNLOAD/);
  assert.match(manager, /stopLoadedOllama/);
  assert.match(manager, /process\.kill\(-run\.pid/);
  assert.match(worker, /HighDoping\/Wan2\.1-Mac/);
  assert.match(worker, /Wan-AI\/Wan2\.1-T2V-1\.3B/);
  assert.match(worker, /--device", "mps/);
  assert.match(worker, /PYTORCH_ENABLE_MPS_FALLBACK/);
  assert.match(worker, /brew.*install/s);
});

test("Create Video API sends generated shot prompts to local runtime", async () => {
  const route = await read("app/api/create-video/route.ts");
  assert.match(route, /prepare_local_video/);
  assert.match(route, /generate_shot/);
  assert.match(route, /startVideoRun/);
  assert.match(route, /ollama_model: settings\.model/);
  assert.match(route, /paid_api_required: false/);
  assert.match(route, /videoRunFileResponse/);
});

test("beta24 patcher wires Tool Service endpoints, local UI controls and version", async () => {
  const patcher = await read("scripts/apply-beta24-create-video-local.mjs");
  assert.match(patcher, /\/v1\/video-runtime\/status/);
  assert.match(patcher, /\/v1\/video-runs/);
  assert.match(patcher, /Prepare Local Video — ฟรี/);
  assert.match(patcher, /Generate Shot · Local/);
  assert.match(patcher, /Copy Prompt/);
  assert.match(patcher, /1\.1\.0-beta\.24/);
});

test("launcher applies beta24 after beta23 and preserves ticket beta22 wiring", async () => {
  const launcher = await read("start-alpha-v11.command");
  const beta23 = launcher.indexOf("apply-beta23-create-video.mjs");
  const beta24 = launcher.indexOf("apply-beta24-create-video-local.mjs");
  assert.ok(beta23 >= 0 && beta24 > beta23);
  assert.match(launcher, /apply-beta22-ticket-visible-evidence\.mjs/);
  assert.match(launcher, /tool-service\/video-run-manager\.mjs/);
  assert.match(launcher, /app_version.*1\.1\.0-beta\.24/);
});

test("Create Video handoff keeps Ticket Bot out of beta24 scope", async () => {
  const handoff = await read("HANDOFF_CREATE_VIDEO_V1.md");
  assert.match(handoff, /DO NOT TOUCH TICKET BOT/);
});
