import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] || process.cwd());
const marker = "alpha-beta22-visible-queue-evidence-v1";

async function writeAtomic(path, content) {
  const temp = `${path}.beta22.tmp`;
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
    '"visible and enabled purchase control"',
    '"reason": "waiting_for_visible_queue_or_sale_control"',
    '"status": "WAITING_ROOM_CONTROL_CHANGED"',
    '"status": "SERVER_ACCESS_DENIED"',
    'state == "unknown" and CONFIG.get("runtimeDiscoveryRequired")',
    '"generatorVersion": "1.1.0-beta.22"',
    '"generator_version": "1.1.0-beta.22"',
    'seat_control_count > 0',
  ];
  const missing = required.filter((needle) => !source.includes(needle));
  if (missing.length) {
    throw new Error(`Beta22 source is incomplete: ${missing.join(", ")}`);
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
    manifest.generator_version = "1.1.0-beta.22";
    manifest.version = Math.max(Number(manifest.version || 1), 22);
    manifest.updated_at = new Date().toISOString();
    await writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch {
    // The entrypoint update is sufficient; a missing optional manifest is not fatal.
  }
}

async function updateVersionAndChangelog() {
  const packagePath = resolve(appDir, "package.json");
  const pkg = JSON.parse(await fs.readFile(packagePath, "utf8"));
  pkg.version = "1.1.0-beta.22";
  await writeAtomic(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

  const changelogPath = resolve(appDir, "CHANGELOG.md");
  let changelog = await fs.readFile(changelogPath, "utf8");
  if (!changelog.includes("## 1.1.0-beta.22")) {
    const entry = `# Alpha changelog\n\n## 1.1.0-beta.22 — 2026-08-25\n\n- Repeated concert inspection and build/run clicks are serialized immediately in the UI, while the API reuses the same passive browser page and in-flight inspection instead of opening duplicate tabs or processes.\n- Passive inspection blocked by the public site now returns a truthful runtime-discovery result instead of an unhandled 500 error.\n- The launcher synchronizes the installed Ticket skill with the beta.22 generator, generated projects record their generator version, and stale or failed projects are rebuilt instead of silently rerun.\n- Repeated Run requests for the same active project reuse one process; stopped or failed runs retain their real result and reason.\n- Ticket Bot queue entry now requires a visible, enabled control; instructional copy containing “รับคิว” can no longer produce a false waiting-room state.\n- Active queue detection now requires explicit queue-progress evidence and no longer treats generic waiting-room wording as proof.\n- Purchase and seat-selection states require visible, enabled live controls instead of incidental instructional text.\n- Generated bots keep the same browser session alive before queue/sale opening, use bounded waits, and recover if a verified control disappears before click.\n- Added generated fixture coverage for hidden/instructional queue, purchase, and seat-selection copy.\n\n`;
    changelog = changelog.replace(/^# Alpha changelog\n\n/, entry);
    await writeAtomic(changelogPath, changelog);
  }
}

await verifyAndMarkTemplate();
await updateInstalledTicketSkill();
await updateVersionAndChangelog();
console.log("Applied Alpha beta22 Ticket Bot visible-control evidence fix");
