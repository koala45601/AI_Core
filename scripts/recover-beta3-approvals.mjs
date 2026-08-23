import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] || process.cwd());
const file = resolve(appDir, "work", "host-tool-confirmations.json");

try {
  const data = JSON.parse(await fs.readFile(file, "utf8"));
  if (!Array.isArray(data.records)) process.exit(0);
  let changed = false;
  const now = Date.now();
  for (const item of data.records) {
    if (item?.status !== "running") continue;
    item.status = "pending";
    item.updatedAt = now;
    item.recoveredAfterRestart = true;
    changed = true;
  }
  if (!changed) process.exit(0);
  const temporary = `${file}.${process.pid}.tmp`;
  data.updated_at = now;
  await fs.writeFile(temporary, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(temporary, file);
  console.log("Recovered interrupted Alpha approvals to pending state");
} catch {
  // No persistent approvals yet.
}
