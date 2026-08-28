import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] || process.cwd());
const packagePath = resolve(appDir, "package.json");
const templatePath = resolve(appDir, "templates", "concert-ticket-assistant.py");
const skillDir = resolve(appDir, "outputs", "Alpha Outputs", "Learned Skills", "concert-ticket-purchase-assistant");
const entrypointPath = resolve(skillDir, "main.py");
const manifestPath = resolve(skillDir, "alpha-skill.json");
const indexPath = resolve(appDir, "work", "skills-index.json");

async function readJson(path) {
  return JSON.parse(await fs.readFile(path, "utf8"));
}

async function writeAtomic(path, content) {
  const temporary = `${path}.sync-${process.pid}.tmp`;
  await fs.writeFile(temporary, content, "utf8");
  await fs.rename(temporary, path);
}

async function fileExists(path) {
  return fs.access(path).then(() => true, () => false);
}

const pkg = await readJson(packagePath);
const appVersion = String(pkg.version || "").trim();
if (!/^(?:1\.1\.0-beta\.\d+|2\.0\.0-alpha\.\d+)$/.test(appVersion)) throw new Error(`เวอร์ชัน Alpha ไม่ถูกต้อง: ${appVersion || "missing"}`);

if (!await fileExists(entrypointPath) || !await fileExists(manifestPath)) {
  console.log(JSON.stringify({ ok: true, status: "not_installed", app_version: appVersion }));
  process.exit(0);
}

const template = await fs.readFile(templatePath, "utf8");
const installed = await fs.readFile(entrypointPath, "utf8");
const manifest = await readJson(manifestPath);
const releaseNumber = appVersion.startsWith("2.0.0-alpha.")
  ? 20_000 + Number(appVersion.match(/alpha\.(\d+)$/)?.[1] || 0)
  : Number(appVersion.match(/beta\.(\d+)$/)?.[1] || 0);
let changed = false;

if (installed !== template) {
  await writeAtomic(entrypointPath, template);
  changed = true;
}

if (manifest.generator_version !== appVersion || Number(manifest.version || 0) < releaseNumber) {
  manifest.generator_version = appVersion;
  manifest.version = Math.max(Number(manifest.version || 1), releaseNumber);
  manifest.updated_at = new Date().toISOString();
  await writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  changed = true;
}

if (changed && await fileExists(indexPath)) {
  const index = await readJson(indexPath).catch(() => null);
  if (Array.isArray(index)) {
    const next = index.filter((item) => item?.id !== manifest.id);
    next.push(manifest);
    await writeAtomic(indexPath, `${JSON.stringify(next, null, 2)}\n`);
  }
}

console.log(JSON.stringify({ ok: true, status: changed ? "updated" : "current", app_version: appVersion }));
