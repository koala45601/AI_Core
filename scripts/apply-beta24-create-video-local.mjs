import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.argv[2] || process.cwd());

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  const index = source.indexOf(before);
  if (index < 0) throw new Error(`หา ${label} ไม่พบ — หยุดแทนการ patch ผิดตำแหน่ง`);
  return source.slice(0, index) + after + source.slice(index + before.length);
}

async function patchServer() {
  const path = resolve(root, "tool-service/server.mjs");
  let source = await fs.readFile(path, "utf8");
  source = replaceOnce(
    source,
    'import { createTicketRunManager } from "./ticket-run-manager.mjs"; // alpha-beta21-ticket-runtime-v1\n',
    'import { createTicketRunManager } from "./ticket-run-manager.mjs"; // alpha-beta21-ticket-runtime-v1\nimport { createVideoRunManager } from "./video-run-manager.mjs"; // alpha-beta24-create-video-local-v1\n',
    "Tool Service video manager import",
  );
  source = replaceOnce(
    source,
    'const ticketRunManager = createTicketRunManager({ programCreateDir, requiredGeneratorVersion: "1.1.0-beta.22" });\n',
    'const ticketRunManager = createTicketRunManager({ programCreateDir, requiredGeneratorVersion: "1.1.0-beta.22" });\nconst videoRunManager = createVideoRunManager({ appDir, outputsDir, workDir }); // alpha-beta24-create-video-local-v1\n',
    "Tool Service video manager init",
  );
  source = replaceOnce(
    source,
    '    if (!await refreshStorageState() && url.pathname !== "/v1/shutdown") return json(response, 503, { error: storageError, storage_connected: false });\n    if (url.pathname === "/v1/ticket-runs" && request.method === "POST") return json(response, 200, await ticketRunManager.start(await readJson(request, 64 * 1024)));\n',
    '    if (!await refreshStorageState() && url.pathname !== "/v1/shutdown") return json(response, 503, { error: storageError, storage_connected: false });\n    // alpha-beta24-create-video-local-v1\n    if (url.pathname === "/v1/video-runtime/status" && request.method === "GET") return json(response, 200, await videoRunManager.runtimeStatus());\n    if (url.pathname === "/v1/video-runs" && request.method === "POST") return json(response, 200, await videoRunManager.start(await readJson(request, 64 * 1024)));\n    const videoRunMatch = url.pathname.match(/^\\/v1\\/video-runs\\/([^/]+)(?:\\/(stop|file))?$/);\n    if (videoRunMatch && request.method === "GET" && !videoRunMatch[2]) return json(response, 200, videoRunManager.get(decodeURIComponent(videoRunMatch[1])));\n    if (videoRunMatch && request.method === "POST" && videoRunMatch[2] === "stop") return json(response, 200, await videoRunManager.stop(decodeURIComponent(videoRunMatch[1])));\n    if (videoRunMatch && request.method === "GET" && videoRunMatch[2] === "file") {\n      const file = await videoRunManager.file(decodeURIComponent(videoRunMatch[1]));\n      const data = await fs.readFile(file.path);\n      response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": data.byteLength, "Content-Disposition": `inline; filename*=UTF-8\'\'${encodeURIComponent(file.name)}`, "Cache-Control": "no-store" });\n      return response.end(data);\n    }\n    if (url.pathname === "/v1/ticket-runs" && request.method === "POST") return json(response, 200, await ticketRunManager.start(await readJson(request, 64 * 1024)));\n',
    "Tool Service video routes",
  );
  source = replaceOnce(
    source,
    '    if (url.pathname === "/v1/shutdown" && request.method === "POST") {\n      await ticketRunManager.stopAll("alpha_shutdown").catch(() => {});\n',
    '    if (url.pathname === "/v1/shutdown" && request.method === "POST") {\n      await videoRunManager.stopAll().catch(() => {}); // alpha-beta24-create-video-local-v1\n      await ticketRunManager.stopAll("alpha_shutdown").catch(() => {});\n',
    "Tool Service shutdown video cleanup",
  );
  source = replaceOnce(
    source,
    '  process.on(signal, async () => {\n    await ticketRunManager.stopAll("alpha_shutdown").catch(() => {});\n',
    '  process.on(signal, async () => {\n    await videoRunManager.stopAll().catch(() => {}); // alpha-beta24-create-video-local-v1\n    await ticketRunManager.stopAll("alpha_shutdown").catch(() => {});\n',
    "Tool Service signal video cleanup",
  );
  await fs.writeFile(path, source, "utf8");
}

async function patchPackage() {
  const path = resolve(root, "package.json");
  let source = await fs.readFile(path, "utf8");
  if (source.includes('"version": "1.1.0-beta.24"')) return;
  if (!source.includes('"version": "1.1.0-beta.23"')) throw new Error("package.json ต้องผ่าน beta23 patch ก่อน beta24");
  source = source.replace('"version": "1.1.0-beta.23"', '"version": "1.1.0-beta.24"');
  await fs.writeFile(path, source, "utf8");
}

await patchServer();
await patchPackage();
console.log("Applied Alpha beta24 Local Create Video runtime");
