import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] || process.cwd());
const wrapperPath = resolve(appDir, "tool-service", "server-wrapper-beta3.mjs");
let source = await fs.readFile(wrapperPath, "utf8");
const marker = "alpha-beta3-confirm-dedupe-v1";

if (source.includes(marker)) {
  console.log("Alpha beta3 confirmation dedupe patch already applied");
  process.exit(0);
}

const needle = `  if (item.status === "completed" || item.status === "denied" || item.status === "failed") {
    return { status: 200, payload: item.cachedResult || { ok: item.status === "completed", denied: item.status === "denied" } };
  }
  if (!approved) {`;

const replacement = `  if (item.status === "completed" || item.status === "denied" || item.status === "failed") {
    return { status: 200, payload: item.cachedResult || { ok: item.status === "completed", denied: item.status === "denied" } };
  }

  // ${marker}
  // A second click/reload may submit the same approval while the first request is
  // still installing. Wait for that shared record to reach a terminal state
  // instead of spawning a duplicate Homebrew process.
  if (item.status === "running") {
    const waitDeadline = Date.now() + 20 * 60_000;
    while (item.status === "running" && Date.now() < waitDeadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }
    if (["completed", "denied", "failed"].includes(String(item.status))) {
      return { status: 200, payload: item.cachedResult || { ok: item.status === "completed", denied: item.status === "denied" } };
    }
    return {
      status: 200,
      payload: {
        ok: false,
        in_progress: true,
        confirmation_id: id,
        message: "ขั้นที่ได้รับอนุญาตยังทำงานอยู่ ระบบจะไม่เริ่ม process ซ้ำ",
        resume: false,
      },
    };
  }

  if (!approved) {`;

if (!source.includes(needle)) {
  throw new Error("หา confirmHostAction block สำหรับ dedupe ไม่พบ — หยุดแทนการ patch ผิดตำแหน่ง");
}

source = source.replace(needle, replacement);
const temporary = `${wrapperPath}.dedupe.tmp`;
await fs.writeFile(temporary, source, "utf8");
await fs.rename(temporary, wrapperPath);
console.log("Applied Alpha beta3 duplicate-confirmation hardening");
