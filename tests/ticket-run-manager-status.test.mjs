import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTicketRunManager } from "../tool-service/ticket-run-manager.mjs";

async function waitForTerminal(manager, id) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = manager.get(id).run;
    if (run && !["starting_runtime", "runtime_running", "waiting_handoff"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("ticket run did not finish");
}

test("handled ticket status is completed with evidence but never marked Full Loop", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-ticket-manager-"));
  const programs = join(root, "Program_Create");
  const project = join(programs, "sold-out-case");
  await mkdir(project, { recursive: true });
  const script = `#!/bin/zsh\nprint -r -- '{"kind":"evidence","status":"SOLD_OUT_BY_SERVER","path":"/tmp/sold-out.png","url":"https://tickets.test/event"}'\nprint -r -- '{"kind":"result","status":"SOLD_OUT_BY_SERVER","live_checkout_verified":false}'\n`;
  try {
    await Promise.all([
      writeFile(join(project, "start.command"), script),
      writeFile(join(project, "run-full-loop.command"), script),
      writeFile(join(project, "bot.py"), "# fixture\n"),
      writeFile(join(project, "config.json"), "{}\n"),
    ]);
    await chmod(join(project, "start.command"), 0o755);
    const manager = createTicketRunManager({ programCreateDir: programs });
    const started = await manager.start({ project_path: project });
    const run = await waitForTerminal(manager, started.run.id);
    assert.equal(run.status, "completed");
    assert.equal(run.stage, "sold_out_by_server");
    assert.equal(run.full_loop_verified, false);
    assert.equal(run.payment_handoff_verified, false);
    assert.deepEqual(run.evidence_paths, ["/tmp/sold-out.png"]);
    assert.match(run.detail, /ไม่ใช่ Full Loop/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("locked price sold out closes normally and exposes verified alternatives", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-ticket-manager-price-"));
  const programs = join(root, "Program_Create");
  const project = join(programs, "selected-price-sold-out");
  await mkdir(project, { recursive: true });
  const options = [{ zone: "B", price: 4800, count: 31, rows: ["A", "B"], sample_seats: ["B-A-04", "B-A-05"] }];
  const script = `#!/bin/zsh\nprint -r -- '${JSON.stringify({ kind: "selection_unavailable", status: "SELECTED_PRICE_SOLD_OUT", reason: "ไม่มีชุดที่นั่งครบตามราคาที่เลือกในทุกโซนที่อนุญาต", preferred_prices: [7000], preferred_rows: [], preferred_seat_numbers: [], wanted: 2, available_options: options, terminal: true, next_action: "close_owned_browser_and_report" })}'\nprint -r -- '${JSON.stringify({ kind: "result", status: "SELECTED_PRICE_SOLD_OUT", reason: "ไม่มีชุดที่นั่งครบตามราคาที่เลือกในทุกโซนที่อนุญาต", preferred_prices: [7000], available_options: options, live_checkout_verified: false })}'\n`;
  try {
    await Promise.all([
      writeFile(join(project, "start.command"), script),
      writeFile(join(project, "run-full-loop.command"), script),
      writeFile(join(project, "bot.py"), "# fixture\n"),
      writeFile(join(project, "config.json"), "{}\n"),
    ]);
    await chmod(join(project, "start.command"), 0o755);
    const manager = createTicketRunManager({ programCreateDir: programs });
    const started = await manager.start({ project_path: project });
    const run = await waitForTerminal(manager, started.run.id);
    assert.equal(run.status, "completed");
    assert.equal(run.stage, "selected_price_sold_out");
    assert.equal(run.result_status, "SELECTED_PRICE_SOLD_OUT");
    assert.deepEqual(run.seat.locked_prices, [7000]);
    assert.deepEqual(run.seat.available_options, options);
    assert.equal(run.full_loop_verified, false);
    assert.equal(run.payment_handoff_verified, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
