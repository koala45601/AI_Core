import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function text(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("Create Video Phase 1 keeps Ticket Bot scope untouched and adds persistent project storage", async () => {
  const store = await text("lib/create-video-store.ts");
  assert.match(store, /CREATE TABLE IF NOT EXISTS create_video_projects/);
  assert.match(store, /target_duration_seconds/);
  assert.match(store, /plan_json/);
  assert.match(store, /updated_at DESC/);
  assert.doesNotMatch(store, /ticket-bot|ticket_run|concert-ticket/i);
});

test("Create Video Director uses story pass, scene-scoped shot pass, repair and continuity validation", async () => {
  const director = await text("lib/create-video-director.ts");
  assert.match(director, /Story Planner/);
  assert.match(director, /Shot Planner/);
  assert.match(director, /GLOBAL STORY SUMMARY/);
  assert.match(director, /PREVIOUS SHOT SUMMARY/);
  assert.match(director, /JSON repair pass/);
  assert.match(director, /applyContinuity/);
  assert.match(director, /invalid_character_refs/);
  assert.match(director, /invalid_location_refs/);
  assert.doesNotMatch(director, /install_packages|install_package|video model download/i);
});

test("Create Video API exposes project, planning and hardware inspection without auto-installing a video model", async () => {
  const route = await text("app/api/create-video/route.ts");
  assert.match(route, /action === "create"/);
  assert.match(route, /action === "save"/);
  assert.match(route, /action === "plan"/);
  assert.match(route, /action === "hardware"/);
  assert.match(route, /system_capability/);
  assert.match(route, /auto_install_video_model: false/);
  assert.match(route, /generation_ready: false/);
});

test("Create Video UI is truthful about Phase 1 and video generation readiness", async () => {
  const ui = await text("components/create-video-studio.tsx");
  assert.match(ui, /LOCAL AI FILM STUDIO · PHASE 1/);
  assert.match(ui, /Character Registry/);
  assert.match(ui, /Location Registry/);
  assert.match(ui, /AI Director: Generate Shot Plan/);
  assert.match(ui, /Video Model: ยังไม่เลือก \/ ไม่ติดตั้งอัตโนมัติ/);
  assert.match(ui, /Generate Shot — Phase 2/);
  assert.match(ui, /Save Edited Shot Plan/);
});

test("beta23 runtime patch wires Create Video into existing sidebar without replacing Chat", async () => {
  const page = await text("app/page.tsx");
  const css = await text("app/globals.css");
  const pkg = JSON.parse(await text("package.json"));
  assert.match(page, /alpha-beta23-create-video-phase1-v1/);
  assert.match(page, /CreateVideoStudio/);
  assert.match(page, /setView\("video"\)/);
  assert.match(page, /setView\("chat"\)/);
  assert.match(page, /LOCAL AI FILM STUDIO/);
  assert.match(css, /alpha-beta23-create-video-phase1-v1/);
  assert.match(css, /\.create-video-view/);
  assert.equal(pkg.version, "1.1.0-beta.28");
});
