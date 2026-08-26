import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] || process.cwd());
const marker = "alpha-beta23-visible-runtime-evidence-v1";

async function writeAtomic(path, content) {
  const temp = `${path}.beta23.tmp`;
  await fs.writeFile(temp, content, "utf8");
  await fs.rename(temp, path);
}

async function verifyAndMarkTemplate() {
  const path = resolve(appDir, "templates", "concert-ticket-assistant.py");
  let source = await fs.readFile(path, "utf8");
  const required = [
    "def _actionable_text(snapshot):",
    "def visible_actionable_controls(page):",
    "def visible_seat_control_count(page):",
    '"visible and enabled waiting-room control"',
    '"visible sale entry on an on-sale page"',
    '"reason": "waiting_for_visible_queue_or_sale_control"',
    '"status": "WAITING_ROOM_CONTROL_CHANGED"',
    '"status": "SERVER_ACCESS_DENIED"',
    'state == "unknown" and CONFIG.get("runtimeDiscoveryRequired")',
    '"generatorVersion": "',
    '"generator_version": "',
    'เลือกรอบ\\s*/\\s*ประเภทบัตร',
    '"status": "INSPECTION_ONLY_NOT_FULL_LOOP"',
    '"browser_visible": True',
    'seat_control_count > 0',
    // beta.24 adds an optional navigation strategy argument while retaining
    // the same selected-performance activation contract.
    "def activate_selected_performance(page",
    '"status": "SELECTED_PERFORMANCE_NOT_AVAILABLE"',
    '"selectedPerformance": {',
  ];
  const missing = required.filter((needle) => !source.includes(needle));
  if (missing.length) {
    throw new Error(`Beta23 source is incomplete: ${missing.join(", ")}`);
  }
  if (!source.includes(marker)) {
    source += `\n# ${marker}\n`;
    await writeAtomic(path, source);
  }
}

async function updateInstalledTicketSkill() {
  const sourcePath = resolve(appDir, "templates", "concert-ticket-assistant.py");
  const skillDir = resolve(appDir, "outputs", "Alpha Outputs", "Learned Skills", "concert-ticket-purchase-assistant");
  const entrypointPath = resolve(skillDir, "main.py");
  const manifestPath = resolve(skillDir, "alpha-skill.json");
  try {
    await fs.access(entrypointPath);
  } catch {
    return;
  }

  const source = await fs.readFile(sourcePath, "utf8");
  await writeAtomic(entrypointPath, source);
  try {
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.generator_version = "1.1.0-beta.23";
    manifest.version = Math.max(Number(manifest.version || 1), 23);
    manifest.updated_at = new Date().toISOString();
    await writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    // The tool service serves the persistent index when it already exists.
    // Keep that index in sync with the installed manifest so health checks and
    // runtime routing cannot keep reporting or executing the previous generator.
    const indexPath = resolve(appDir, "work", "skills-index.json");
    try {
      const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
      if (Array.isArray(index)) {
        const next = index.filter((item) => item?.id !== manifest.id);
        next.push(manifest);
        await writeAtomic(indexPath, `${JSON.stringify(next, null, 2)}\n`);
      }
    } catch {
      // A missing index is rebuilt from the manifests by the tool service.
    }
  } catch {
    // The entrypoint update is sufficient; a missing optional manifest is not fatal.
  }
}

async function updateVersionAndChangelog() {
  const packagePath = resolve(appDir, "package.json");
  const pkg = JSON.parse(await fs.readFile(packagePath, "utf8"));
  pkg.version = "1.1.0-beta.23";
  await writeAtomic(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

  const changelogPath = resolve(appDir, "CHANGELOG.md");
  let changelog = await fs.readFile(changelogPath, "utf8");
  if (!changelog.includes("## 1.1.0-beta.23")) {
    const entry = `# Alpha changelog\n\n## 1.1.0-beta.23 — 2026-08-25\n\n- “ตรวจคอนเสิร์ต” refreshes each open/upcoming event once, stores announced show dates plus queue/sale times in D1, and reuses that session cache until the user explicitly refreshes again.\n- Multi-day events require a saved day/round selection before build; the generated bot keeps that exact selection through the same waiting-room session and never falls back to another day silently.\n- Recognizes the real visible ThaiTicketMajor “เลือกรอบ/ประเภทบัตร” control as sale entry and activates it during a live run.\n- Inspect-only keeps the visible isolated Chrome window open for review and reports INSPECTION_ONLY_NOT_FULL_LOOP instead of completion.\n- A zero-exit process without verified PAYMENT_HANDOFF is reported as not_verified, never completed.\n- Ticket Studio shows a readable action timeline and separates Fixture, live runtime, and verified Full Loop states.\n- The browser remains visible without moving the system mouse; API observations and DOM actions are surfaced as runtime evidence.\n\n`;
    changelog = changelog.replace(/^# Alpha changelog\n\n/, entry);
    await writeAtomic(changelogPath, changelog);
  }
}

await verifyAndMarkTemplate();
await updateInstalledTicketSkill();
await updateVersionAndChangelog();
console.log("Applied Alpha beta23 Ticket Bot schedule-cache and selected-performance fix");
