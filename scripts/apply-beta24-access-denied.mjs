import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] || process.cwd());
const version = "1.1.0-beta.24";

async function writeAtomic(path, content) {
  const temporary = `${path}.beta24.tmp`;
  await fs.writeFile(temporary, content, "utf8");
  await fs.rename(temporary, path);
}

async function assertSource(path, needles) {
  const source = await fs.readFile(resolve(appDir, path), "utf8");
  const missing = needles.filter((needle) => !source.includes(needle));
  if (missing.length) throw new Error(`Beta24 source is incomplete in ${path}: ${missing.join(", ")}`);
}

await assertSource("app/api/ticket-bot/route.ts", [
  "alpha-beta24-access-denied-v1",
  'action: "observe_existing"',
  'inspectPage(url, settings, "events")',
  "inspectPublicDetailText",
  'inspection_transport: "direct_web_read"',
  "publicInspectionFallback(url, mode) || url",
]);
await assertSource("lib/ticket-workflow.js", [
  "explicitSoldOut",
  'ticket_status: explicitSoldOut || allInPersonSoldOut ? "sold_out"',
]);
await assertSource("tool-service/server.mjs", [
  "public-inspection-profile",
  "ticket-browser-profile",
  "throttlePublicInspectionNavigation",
  'action === "observe_existing"',
  'ignoreDefaultArgs: ["--no-sandbox", "--enable-automation"]',
  "await page.close().catch(() => {})",
]);
await assertSource("tool-service/ticket-run-manager.mjs", [
  "ALPHA_TICKET_BROWSER_PROFILE",
  "อีกงานกำลังใช้ browser session",
]);
await assertSource("templates/concert-ticket-assistant.py", [
  `"generatorVersion": "${version}"`,
  "ALPHA_TICKET_BROWSER_PROFILE",
  "persistent_ticket_session",
  "connect_over_cdp",
  "--remote-debugging-port",
]);

const packagePath = resolve(appDir, "package.json");
const pkg = JSON.parse(await fs.readFile(packagePath, "utf8"));
pkg.version = version;
await writeAtomic(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

const templatePath = resolve(appDir, "templates", "concert-ticket-assistant.py");
const skillDir = resolve(appDir, "outputs", "Alpha Outputs", "Learned Skills", "concert-ticket-purchase-assistant");
const skillEntry = resolve(skillDir, "main.py");
try {
  await fs.access(skillEntry);
  await writeAtomic(skillEntry, await fs.readFile(templatePath, "utf8"));
  const manifestPath = resolve(skillDir, "alpha-skill.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.generator_version = version;
  manifest.version = Math.max(Number(manifest.version || 1), 24);
  manifest.updated_at = new Date().toISOString();
  await writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const indexPath = resolve(appDir, "work", "skills-index.json");
  try {
    const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
    if (Array.isArray(index)) {
      const next = index.filter((item) => item?.id !== manifest.id);
      next.push(manifest);
      await writeAtomic(indexPath, `${JSON.stringify(next, null, 2)}\n`);
    }
  } catch {
    // The tool service rebuilds a missing optional index from manifests.
  }
} catch {
  // First launch may install the skill later in the startup sequence.
}

console.log(`Applied Alpha ${version} Access Denied prevention`);
