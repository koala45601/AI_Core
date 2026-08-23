import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] || process.cwd());
const path = resolve(appDir, "tool-service", "server.mjs");
const marker = "alpha-beta10-persistent-search-v1";
let source = await fs.readFile(path, "utf8");

if (source.includes(marker)) {
  console.log("Alpha beta10 persistent search already applied");
  process.exit(0);
}

function replaceOnce(needle, replacement, label) {
  if (!source.includes(needle)) throw new Error(`หา ${label} ไม่พบ — หยุดแทนการ patch ผิดตำแหน่ง`);
  source = source.replace(needle, replacement);
}

replaceOnce(
`async function ensureSearxng() {
  if (!await refreshStorageState()) throw new Error(storageError);
  lastHeavyUse = Date.now();
  try {`,
`async function ensureSearxng() {
  if (!await refreshStorageState()) throw new Error(storageError);
  try {`,
"ensureSearxng idle coupling",
);

replaceOnce(
`async function searchWeb(query) {
  let searxError = "";`,
`async function searchWeb(query) {
  lastHeavyUse = Date.now();
  let searxError = "";`,
"searchWeb activity tracking",
);

replaceOnce(
`  if (lastHeavyUse && Date.now() - lastHeavyUse > idleSeconds * 1000) {
    lastHeavyUse = 0;
    await stopHeavyTools().catch(() => {});
  }
}, 15_000).unref();

await cleanupOwnedSkillLabResources().catch(() => {});
await restoreLastAutoLearn();`,
`  if (lastHeavyUse && Date.now() - lastHeavyUse > idleSeconds * 1000) {
    lastHeavyUse = 0;
    // ${marker}
    // Reclaim UI/browser state only. Search service lifetime is the Alpha session,
    // not the generic heavy-tool idle timeout.
    if (alphaContext) await alphaContext.close().catch(() => {});
    alphaContext = null;
  }
}, 15_000).unref();

await cleanupOwnedSkillLabResources().catch(() => {});
await restoreLastAutoLearn();

// ${marker}: keep local search warm for the whole Tool Service lifetime.
// Start eagerly and self-heal if the SearXNG container exits while Alpha is open.
let searxngKeepAliveBusy = false;
async function keepSearxngAlive() {
  if (searxngKeepAliveBusy || !storageConnected) return;
  searxngKeepAliveBusy = true;
  try {
    await ensureSearxng();
    if (lastToolError.startsWith("SearXNG keepalive:")) lastToolError = "";
  } catch (error) {
    const reason = error instanceof Error ? error.message : "SearXNG ไม่พร้อม";
    lastToolError = "SearXNG keepalive: " + reason;
  } finally {
    searxngKeepAliveBusy = false;
  }
}

void keepSearxngAlive();
setInterval(() => { void keepSearxngAlive(); }, 30_000).unref();`,
"idle cleanup and persistent SearXNG lifecycle",
);

const temporary = `${path}.beta10.tmp`;
await fs.writeFile(temporary, source, "utf8");
await fs.rename(temporary, path);
console.log("Applied Alpha beta10 persistent search: SearXNG stays warm while Alpha is open");
