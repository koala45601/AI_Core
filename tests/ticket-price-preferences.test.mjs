import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { extractTicketPageFacts } from "../lib/ticket-workflow.js";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("inspection groups evidence-backed prices by zone without inventing seat prices", () => {
  const facts = extractTicketPageFacts({
    url: "https://tickets.test/price-fixture",
    title: "Price fixture",
    body_text: "วันที่แสดง 30 สิงหาคม 2569 วันเปิดขาย 25 สิงหาคม 2569 Ticket Status ON SALE ราคาบัตร 7,000 / 2,000 บาท",
    discovered_zones: ["S"],
    controls: [
      { semantic_role: "seat_or_zone", label: "โซน S", context_text: "โซน S", price: "7000" },
      { semantic_role: "seat_or_zone", label: "โซน S", context_text: "โซน S", price: "2000" },
    ],
    seat_map_detected: true,
  });

  assert.deepEqual(facts.prices, [7000, 2000]);
  assert.deepEqual(facts.price_tiers, [{
    zone: "S",
    prices: [7000, 2000],
    source: "dom_attribute",
    evidence: "โซน S โซน S",
  }]);
});

test("generated bot carries optional prices and filters only seats with a verified price", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "alpha-ticket-price-"));
  const output = join(temporary, "output");
  const programs = join(temporary, "programs");
  const payload = {
    event_url: "https://tickets.test/price-fixture",
    event_candidates: [{ id: "price-fixture", name: "Price fixture", url: "https://tickets.test/price-fixture", sale_status: "open" }],
    selected_event_id: "price-fixture",
    selected_event_name: "Price fixture",
    schedule: "2026-08-30T19:00:00+07:00",
    sale_open_at: "2026-08-25T10:00:00+07:00",
    event_facts: {
      sale_status: "open",
      show_dates: [{ iso: "2026-08-30T19:00:00+07:00" }],
      price_tiers: [{ zone: "S", prices: [7000, 2000], source: "dom_attribute" }],
    },
    functional_preflight: { public_page_verified: true },
    quantity: 2,
    seat_mode: "reserved",
    seat_grouping: "same_zone",
    preferred_zones: ["S"],
    preferred_prices: [2000],
    seat_fallback_mode: "nearest",
    delivery_method: "pickup",
    payment_method: "qr",
    project_name: "price-fixture",
  };
  try {
    const generated = await run("python3", ["templates/concert-ticket-assistant.py", JSON.stringify(payload)], {
      cwd: "/Volumes/petong/Disk/AI",
      env: { ...process.env, ALPHA_OUTPUT_DIR: output, ALPHA_PROGRAM_CREATE_DIR: programs },
    });
    assert.equal(generated.code, 0, generated.stderr || generated.stdout);
    const result = JSON.parse(generated.stdout.trim().split("\n").at(-1));
    const config = JSON.parse(await readFile(join(result.created_project_path, "config.json"), "utf8"));
    assert.deepEqual(config.preferredPrices, [2000]);
    assert.deepEqual(config.priceTiers, [{ zone: "S", prices: [7000, 2000], source: "dom_attribute" }]);

    const selection = await run("python3", ["-c", [
      "import json, sys",
      "sys.path.insert(0, sys.argv[1])",
      "from state_machine import choose_seat_indices",
      "seats = [{'zone':'S','row':'A','number':'1','price':7000,'available':True},{'zone':'S','row':'A','number':'2','price':2000,'available':True},{'zone':'S','row':'A','number':'3','price':2000,'available':True}]",
      "print(json.dumps(choose_seat_indices(seats, 2, 'same_zone', ['S'], [], [], 'nearest', [2000])))",
    ].join(";"), result.created_project_path], { cwd: result.created_project_path });
    assert.equal(selection.code, 0, selection.stderr || selection.stdout);
    assert.deepEqual(JSON.parse(selection.stdout.trim()), [1, 2]);

    const noPreference = await run("python3", ["-c", [
      "import json, sys",
      "sys.path.insert(0, sys.argv[1])",
      "from state_machine import choose_seat_indices",
      "seats = [{'zone':'S','row':'A','number':'1','price':7000,'available':True},{'zone':'S','row':'A','number':'2','price':2000,'available':True}]",
      "print(json.dumps(choose_seat_indices(seats, 2, 'same_zone', ['S'], [], [], 'nearest', [])))",
    ].join(";"), result.created_project_path], { cwd: result.created_project_path });
    assert.equal(noPreference.code, 0, noPreference.stderr || noPreference.stdout);
    assert.deepEqual(JSON.parse(noPreference.stdout.trim()), [0, 1]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
