import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] || process.cwd());
const path = resolve(appDir, "tool-service", "server.mjs");
let source = await fs.readFile(path, "utf8");
const marker = "alpha-beta4-shell-artifacts-v1";
if (source.includes(marker)) process.exit(0);

if (!source.includes(`".py": "text/x-python", ".js": "text/javascript", ".mjs": "text/javascript",`)) throw new Error("หา mime map ไม่พบ");
source = source.replace(
  `".py": "text/x-python", ".js": "text/javascript", ".mjs": "text/javascript",`,
  `".py": "text/x-python", ".js": "text/javascript", ".mjs": "text/javascript", ".sh": "text/x-shellscript", // ${marker}`,
);

if (!source.includes(`const allowed = new Set([".py", ".js", ".mjs", ".html", ".css", ".json", ".md", ".txt", ".csv"]);`)) throw new Error("หา allowed extensions ไม่พบ");
source = source.replace(
  `const allowed = new Set([".py", ".js", ".mjs", ".html", ".css", ".json", ".md", ".txt", ".csv"]);`,
  `const allowed = new Set([".py", ".js", ".mjs", ".sh", ".html", ".css", ".json", ".md", ".txt", ".csv"]);`,
);

const validationNeedle = `      if ([".js", ".mjs"].includes(extname(item.path).toLowerCase())) await run(process.execPath, ["--check", filePath], { timeout: 12_000 });`;
if (!source.includes(validationNeedle)) throw new Error("หา validation block ไม่พบ");
source = source.replace(
  validationNeedle,
  `${validationNeedle}\n      if (extname(item.path).toLowerCase() === ".sh") await run("/bin/zsh", ["-n", filePath], { timeout: 12_000 });`,
);

const tmp = `${path}.beta4-shell.tmp`;
await fs.writeFile(tmp, source, "utf8");
await fs.rename(tmp, path);
console.log("Applied beta4 shell artifact support");
