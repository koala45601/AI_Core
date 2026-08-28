import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTicketRunManager } from "../tool-service/ticket-run-manager.mjs";

async function waitFor(check, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  }
  throw new Error("timeout waiting for ticket runtime state");
}

async function project(root, name, script) {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  await Promise.all([
    writeFile(join(path, "start.command"), script, "utf8"),
    writeFile(join(path, "run-full-loop.command"), "#!/bin/bash\nexit 0\n", "utf8"),
    writeFile(join(path, "bot.py"), "print('fixture')\n", "utf8"),
    writeFile(join(path, "config.json"), "{}\n", "utf8"),
  ]);
  return path;
}

test("Ticket Run Manager validates Program_Create, streams handoff, redacts credentials and completes only with runtime evidence", async () => {
  const temp = await mkdtemp(join(tmpdir(), "alpha-ticket-runtime-"));
  const root = join(temp, "Program_Create");
  await mkdir(root);
  const path = await project(root, "demo", `#!/bin/bash\necho '{"kind":"runtime","stage":"starting_browser"}'\necho "password=$TICKET_PASSWORD" >&2\necho '{"kind":"input_required","field":"zone","stage":"waiting_zone","options":["A1","A2"],"prompt":"เลือกโซน"}'\nIFS= read -r zone\necho '{"kind":"wait","state":"queue"}'\necho '{"kind":"ai_analysis","status":"READY","state":"ticket_selection","action":"fast_seat_engine","diagnosis":"complete set available","confidence":0.95,"background":true}'\necho '{"kind":"ai_action","state":"ticket_selection","action":"fast_seat_engine","executed":true}'\necho '{"kind":"ai_strategy_learned","state":"ticket_selection","to_state":"checkout_options","action":"fast_seat_engine"}'\necho '{"kind":"reservation_verified","status":"SEAT_HOLD_VERIFIED","zone":"A1","selected":2,"wanted":2,"attempt":1}'\necho '{"kind":"result","status":"PAYMENT_HANDOFF","live_checkout_verified":true}'\necho '{"kind":"input_required","field":"payment","stage":"payment_handoff","prompt":"หยุดก่อนจ่าย"}'\nIFS= read -r done\nexit 0\n`);
  const manager = createTicketRunManager({ programCreateDir: root, shellPath: "/bin/bash" });
  try {
    const started = await manager.start({ project_path: path, username: "demo@example.com", password: "super-secret-value" });
    assert.equal(started.ok, true);
    assert.ok(started.run.id);
    assert.ok(started.run.pid);

    const waitingZone = await waitFor(() => {
      const run = manager.get(started.run.id).run;
      return run.status === "waiting_handoff" && run.handoff?.field === "zone" ? run : null;
    });
    assert.deepEqual(waitingZone.handoff.options, ["A1", "A2"]);
    assert.equal(JSON.stringify(waitingZone).includes("super-secret-value"), false);
    assert.ok(waitingZone.logs.some((item) => item.text.includes("password=[REDACTED]")));

    await manager.input(started.run.id, "A1");
    const payment = await waitFor(() => {
      const run = manager.get(started.run.id).run;
      return run.status === "waiting_handoff" && run.stage === "payment_handoff" ? run : null;
    });
    assert.equal(payment.payment_handoff_verified, true);
    assert.equal(payment.reservation_verified, true);
    assert.equal(payment.full_loop_verified, true);
    assert.equal(payment.ai.action, "fast_seat_engine");
    assert.equal(payment.ai.last_action_executed, true);
    assert.equal(payment.ai.learned_strategy_count, 1);
    await manager.input(started.run.id, "");
    const completed = await waitFor(() => {
      const run = manager.get(started.run.id).run;
      return run.status === "completed" ? run : null;
    });
    assert.equal(completed.stage, "completed_payment_handoff");
  } finally {
    await manager.stopAll();
    await rm(temp, { recursive: true, force: true });
  }
});

test("Ticket Run Manager rejects paths outside Program_Create and symlink escape", async () => {
  const temp = await mkdtemp(join(tmpdir(), "alpha-ticket-scope-"));
  const root = join(temp, "Program_Create");
  const outside = join(temp, "outside");
  await mkdir(root);
  await project(temp, "outside", "#!/bin/bash\nexit 0\n");
  const manager = createTicketRunManager({ programCreateDir: root, shellPath: "/bin/bash" });
  try {
    await assert.rejects(() => manager.start({ project_path: outside }), /นอก Program_Create/);
    await symlink(outside, join(root, "escape"));
    await assert.rejects(() => manager.start({ project_path: join(root, "escape") }), /symlink|หลุดออก/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Ticket Run Manager stops only its owned process group", async () => {
  const temp = await mkdtemp(join(tmpdir(), "alpha-ticket-stop-"));
  const root = join(temp, "Program_Create");
  await mkdir(root);
  const path = await project(root, "slow", "#!/bin/bash\necho '{\"kind\":\"runtime\",\"stage\":\"running\"}'\nsleep 30\n");
  const manager = createTicketRunManager({ programCreateDir: root, shellPath: "/bin/bash" });
  try {
    const started = await manager.start({ project_path: path });
    await manager.stop(started.run.id);
    const stopped = await waitFor(() => manager.get(started.run.id).run.status === "stopped" ? manager.get(started.run.id).run : null);
    assert.equal(stopped.stage, "stopped");
  } finally {
    await manager.stopAll();
    await rm(temp, { recursive: true, force: true });
  }
});

test("Ticket Run Manager never treats a zero-exit inspection as Full Loop success", async () => {
  const temp = await mkdtemp(join(tmpdir(), "alpha-ticket-not-verified-"));
  const root = join(temp, "Program_Create");
  await mkdir(root);
  const path = await project(root, "inspection-only", `#!/bin/bash\necho '{"kind":"result","status":"INSPECTION_ONLY_NOT_FULL_LOOP","reason":"ตรวจเฉพาะหน้าแรก","live_checkout_verified":false}'\nexit 0\n`);
  const manager = createTicketRunManager({ programCreateDir: root, shellPath: "/bin/bash" });
  try {
    const started = await manager.start({ project_path: path });
    const ended = await waitFor(() => {
      const run = manager.get(started.run.id).run;
      return run.status === "not_verified" ? run : null;
    });
    assert.equal(ended.full_loop_verified, false);
    assert.equal(ended.payment_handoff_verified, false);
    assert.equal(ended.stage, "inspection_only_not_full_loop");
    assert.match(ended.detail, /ยังไม่ผ่าน Full Loop/);
  } finally {
    await manager.stopAll();
    await rm(temp, { recursive: true, force: true });
  }
});

test("Ticket Run Manager rejects stale generators and reuses one active process for repeated Run clicks", async () => {
  const temp = await mkdtemp(join(tmpdir(), "alpha-ticket-version-"));
  const root = join(temp, "Program_Create");
  await mkdir(root);
  const path = await project(root, "versioned", "#!/bin/bash\necho '{\"kind\":\"runtime\",\"stage\":\"running\"}'\nsleep 30\n");
  const manager = createTicketRunManager({ programCreateDir: root, shellPath: "/bin/bash", requiredGeneratorVersion: "1.1.0-beta.23" });
  try {
    await assert.rejects(() => manager.start({ project_path: path }), /เวอร์ชันเก่า|สร้างใหม่/);
    await writeFile(join(path, "config.json"), JSON.stringify({ generatorVersion: "1.1.0-beta.23" }), "utf8");
    const first = await manager.start({ project_path: path });
    const second = await manager.start({ project_path: path });
    assert.equal(second.reused, true);
    assert.equal(second.run.id, first.run.id);
    assert.equal(second.run.pid, first.run.pid);
    await manager.stop(first.run.id);
  } finally {
    await manager.stopAll();
    await rm(temp, { recursive: true, force: true });
  }
});

test("Ticket Run Manager shares one persistent ticket profile and blocks competing projects", async () => {
  const temp = await mkdtemp(join(tmpdir(), "alpha-ticket-shared-profile-"));
  const root = join(temp, "Program_Create");
  const profile = join(temp, "work", "ticket-browser-profile");
  await mkdir(root, { recursive: true });
  const firstPath = await project(root, "first", "#!/bin/bash\necho '{\"kind\":\"runtime\",\"stage\":\"running\"}'\nsleep 30\n");
  const secondPath = await project(root, "second", "#!/bin/bash\nexit 0\n");
  const manager = createTicketRunManager({ programCreateDir: root, ticketBrowserProfileDir: profile, shellPath: "/bin/bash" });
  try {
    const first = await manager.start({ project_path: firstPath });
    await assert.rejects(() => manager.start({ project_path: secondPath }), /อีกงานกำลังใช้ browser session/);
    await manager.stop(first.run.id);
  } finally {
    await manager.stopAll();
    await rm(temp, { recursive: true, force: true });
  }
});

test("ticket runtime wires compatibility endpoints, SSE with polling fallback, handoff input and truthful fixture wording", async () => {
  const server = await readFile(new URL("../tool-service/server.mjs", import.meta.url), "utf8");
  const client = await readFile(new URL("../lib/tool-client.ts", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/ticket-bot/route.ts", import.meta.url), "utf8");
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const template = await readFile(new URL("../templates/concert-ticket-assistant.py", import.meta.url), "utf8");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.match(server, /createTicketRunManager/);
  assert.match(server, /\/v1\/ticket-runs/);
  assert.match(server, /ticketRunManager\.stopAll\("alpha_shutdown"\)/);
  assert.match(client, /startTicketRun/);
  assert.match(client, /sendTicketRunInput/);
  assert.match(route, /"run_status"/);
  assert.match(route, /"run_stop"/);
  assert.match(page, /สร้างและเริ่มบอท/);
  assert.match(page, /Live Ticket Run/);
  assert.match(page, /new EventSource\(`/);
  assert.match(page, /window\.setInterval\(\(\) => void poll\(\), 5_000\)/);
  assert.match(page, /ผ่านเฉพาะโครงสร้างและ fixture — ยังไม่ใช่ผลซื้อบัตรจริง/);
  assert.match(template, /record\("input_required"/);
  assert.match(template, /"field": "captcha" if state == "captcha_handoff" else "otp"/);
  assert.match(template, /wait_for_post_login_transition\(page, login_url\)/);
  assert.match(template, /terms_accepted_under_run_authorization/);
  assert.match(page, /"access_denied", "terms"/);
  assert.match(template, /bot_source = r'''[\s\S]*from urllib\.parse import[^\n]*urlsplit[\s\S]*def on_response\(response\):[\s\S]*urlsplit\(response\.url\)/);
  assert.match(template, /activate_selected_performance\(page, prefer_target_navigation=True\)/);
  assert.match(template, /verified_target_avoids_javascript_popup/);
  assert.equal(pkg.version, "2.0.0-alpha.1");
});
