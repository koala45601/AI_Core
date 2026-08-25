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

async function patchComponent() {
  const path = resolve(root, "components/create-video-studio.tsx");
  let source = await fs.readFile(path, "utf8");
  source = replaceOnce(
    source,
    'interface HardwareSnapshot {\n  capability?: Record<string, unknown>;\n  policy?: { memory_strategy?: string; auto_install_video_model?: boolean; video_model_selected?: boolean; note?: string };\n}\n',
    'interface HardwareSnapshot {\n  capability?: Record<string, unknown>;\n  runtime?: VideoRuntime;\n  policy?: { memory_strategy?: string; local_only?: boolean; paid_api_required?: boolean; backend?: string; note?: string };\n}\n\ninterface VideoRuntime extends Record<string, unknown> {\n  generation_ready?: boolean;\n  backend_ready?: boolean;\n  model_ready?: boolean;\n  total_memory_gb?: number;\n  free_memory_gb?: number;\n  disk?: { free_gb?: number };\n  note?: string;\n}\n\ninterface VideoRun extends Record<string, unknown> {\n  id: string;\n  kind: "prepare" | "generate";\n  status: string;\n  stage: string;\n  detail?: string;\n  progress?: number;\n  output_path?: string | null;\n  output_name?: string | null;\n  logs?: Array<{ at: number; stream: string; text: string }>;\n}\n',
    "Create Video runtime types",
  );
  source = replaceOnce(
    source,
    '  const [message, setMessage] = useState("Phase 1 พร้อม: Project + Director + Shot Planner + Continuity");\n  const [hardware, setHardware] = useState<HardwareSnapshot | null>(null);\n  const [health, setHealth] = useState<Record<string, unknown> | null>(null);\n',
    '  const [message, setMessage] = useState("Local Film Studio พร้อม: Director + Shot Planner + Local Video Renderer");\n  const [hardware, setHardware] = useState<HardwareSnapshot | null>(null);\n  const [health, setHealth] = useState<Record<string, unknown> | null>(null);\n  const [videoRuntime, setVideoRuntime] = useState<VideoRuntime | null>(null);\n  const [prepareRunId, setPrepareRunId] = useState("");\n  const [shotRunIds, setShotRunIds] = useState<Record<string, string>>({});\n  const [videoRuns, setVideoRuns] = useState<Record<string, VideoRun>>({});\n',
    "Create Video runtime state",
  );
  source = replaceOnce(
    source,
    '      if (hardwareResult && !hardwareResult.error) setHardware(hardwareResult as HardwareSnapshot);\n      setHealth(healthResult && typeof healthResult === "object" ? healthResult as Record<string, unknown> : null);\n    });\n  }, []);\n',
    '      if (hardwareResult && !hardwareResult.error) {\n        const snapshot = hardwareResult as HardwareSnapshot;\n        setHardware(snapshot);\n        setVideoRuntime(snapshot.runtime || null);\n      }\n      setHealth(healthResult && typeof healthResult === "object" ? healthResult as Record<string, unknown> : null);\n    });\n  }, []);\n\n  useEffect(() => {\n    const ids = [...new Set([prepareRunId, ...Object.values(shotRunIds)].filter(Boolean))];\n    if (!ids.length) return;\n    let cancelled = false;\n    const poll = async () => {\n      for (const id of ids) {\n        try {\n          const data = await api({ action: "run_status", run_id: id });\n          const run = data.run as VideoRun;\n          if (!cancelled && run?.id) {\n            setVideoRuns((current) => ({ ...current, [run.id]: run }));\n            if (run.kind === "prepare" && run.status === "completed") {\n              const runtimeData = await api({ action: "runtime_status" });\n              if (!cancelled) setVideoRuntime(runtimeData.runtime as VideoRuntime);\n            }\n          }\n        } catch { /* keep UI responsive while Tool Service restarts */ }\n      }\n    };\n    void poll();\n    const timer = window.setInterval(() => void poll(), 1500);\n    return () => { cancelled = true; window.clearInterval(timer); };\n  }, [prepareRunId, shotRunIds]);\n',
    "Create Video runtime polling",
  );
  source = replaceOnce(
    source,
    '  function updateShot(index: number, patch: Record<string, unknown>) {\n',
    '  async function prepareLocalVideo() {\n    setBusy("prepare-video");\n    setMessage("กำลังเตรียม Local Video backend/model บน Mac — ครั้งแรกอาจดาวน์โหลดหลาย GB…");\n    try {\n      const data = await api({ action: "prepare_local_video" });\n      const run = data.run as VideoRun;\n      setPrepareRunId(run.id);\n      setVideoRuns((current) => ({ ...current, [run.id]: run }));\n      setMessage("เริ่มเตรียม Wan2.1 1.3B แบบ Local แล้ว ไม่ใช้ paid API");\n    } catch (error) {\n      setMessage(error instanceof Error ? error.message : "เตรียม Local Video ไม่สำเร็จ");\n    } finally {\n      setBusy("");\n    }\n  }\n\n  async function generateShotLocal(shotId: string) {\n    if (!active) return;\n    setMessage(`กำลังเริ่ม Local Render ${shotId}…`);\n    try {\n      const data = await api({ action: "generate_shot", id: active.id, shot_id: shotId });\n      const run = data.run as VideoRun;\n      setShotRunIds((current) => ({ ...current, [shotId]: run.id }));\n      setVideoRuns((current) => ({ ...current, [run.id]: run }));\n      setMessage(`${shotId} กำลัง render บน Mac ด้วย Wan2.1/MPS`);\n    } catch (error) {\n      setMessage(error instanceof Error ? error.message : "Generate Shot ไม่สำเร็จ");\n    }\n  }\n\n  async function stopVideoRunLocal(runId: string) {\n    try {\n      const data = await api({ action: "run_stop", run_id: runId });\n      const run = data.run as VideoRun;\n      setVideoRuns((current) => ({ ...current, [run.id]: run }));\n    } catch (error) {\n      setMessage(error instanceof Error ? error.message : "หยุด render ไม่สำเร็จ");\n    }\n  }\n\n  async function copyPrompt(text: string) {\n    await navigator.clipboard.writeText(text);\n    setMessage("Copy Video Prompt แล้ว");\n  }\n\n  function updateShot(index: number, patch: Record<string, unknown>) {\n',
    "Create Video local render actions",
  );
  source = source.replace('LOCAL AI FILM STUDIO · PHASE 1', 'LOCAL AI FILM STUDIO · LOCAL RENDER');
  source = source.replace('วาง Story → Character/Location Registry → Scene → Shot Plan ด้วย Local Director ก่อนโหลด Video Model จริง', 'วาง Story → AI Director → Shot Plan → Render แต่ละ Shot บน Mac แบบ Local ไม่ใช้ paid video API');
  source = replaceOnce(
    source,
    '          <b>Video Model: ยังไม่เลือก / ไม่ติดตั้งอัตโนมัติ</b>\n',
    '          <b>{videoRuntime?.generation_ready ? "Video Model: Wan2.1 1.3B · LOCAL READY" : "Video Model: Wan2.1 1.3B · ยังไม่พร้อม"}</b>\n          <button type="button" onClick={() => void prepareLocalVideo()} disabled={busy === "prepare-video" || Boolean(prepareRunId && ["starting", "preparing", "running"].includes(videoRuns[prepareRunId]?.status || ""))}>{videoRuntime?.generation_ready ? "ตรวจ Local Video อีกครั้ง" : "Prepare Local Video — ฟรี"}</button>\n          {prepareRunId && <small>{videoRuns[prepareRunId]?.stage || "starting"} · {Math.round(Number(videoRuns[prepareRunId]?.progress || 0))}% {videoRuns[prepareRunId]?.detail || ""}</small>}\n',
    "Create Video local runtime card",
  );
  source = replaceOnce(
    source,
    '<div className="shot-inline"><label><span>Duration</span><input type="number" min="2" max="12" value={shot.duration} onChange={(event) => updateShot(index, { duration: Math.min(12, Math.max(2, Number(event.target.value) || 2)) })} /></label><button type="button" disabled title="Phase 2 จะเชื่อม Local Video Adapter">Generate Shot — Phase 2</button></div>',
    '<div className="shot-inline"><label><span>Duration</span><input type="number" min="2" max="12" value={shot.duration} onChange={(event) => updateShot(index, { duration: Math.min(12, Math.max(2, Number(event.target.value) || 2)) })} /></label><button type="button" onClick={() => void copyPrompt(shot.video_prompt)}>Copy Prompt</button><button type="button" onClick={() => void generateShotLocal(shot.shot_id)} disabled={!videoRuntime?.generation_ready || Boolean(shotRunIds[shot.shot_id] && ["starting", "running", "preparing"].includes(videoRuns[shotRunIds[shot.shot_id]]?.status || ""))}>{shotRunIds[shot.shot_id] && ["starting", "running"].includes(videoRuns[shotRunIds[shot.shot_id]]?.status || "") ? "Rendering…" : "Generate Shot · Local"}</button>{shotRunIds[shot.shot_id] && ["starting", "running", "preparing"].includes(videoRuns[shotRunIds[shot.shot_id]]?.status || "") && <button type="button" onClick={() => void stopVideoRunLocal(shotRunIds[shot.shot_id])}>Stop</button>}</div>{shotRunIds[shot.shot_id] && <div className="shot-render-status"><small>{videoRuns[shotRunIds[shot.shot_id]]?.stage || "starting"} · {Math.round(Number(videoRuns[shotRunIds[shot.shot_id]]?.progress || 0))}% {videoRuns[shotRunIds[shot.shot_id]]?.detail || ""}</small>{videoRuns[shotRunIds[shot.shot_id]]?.status === "completed" && <video className="shot-video-preview" controls preload="metadata" src={`/api/create-video?run_id=${encodeURIComponent(shotRunIds[shot.shot_id])}&file=1`} />}</div>}',
    "Create Video local shot button",
  );
  await fs.writeFile(path, source, "utf8");
}

async function patchStyles() {
  const path = resolve(root, "app/globals.css");
  let source = await fs.readFile(path, "utf8");
  if (source.includes("alpha-beta24-create-video-local-v1")) return;
  source += `\n/* alpha-beta24-create-video-local-v1 */\n.create-video-resource-card button { border: 1px solid #b8d1c4; border-radius: 9px; background: #e8f3ed; color: var(--green-dark); padding: 7px 10px; cursor: pointer; font-size: 10px; font-weight: 700; }\n.create-video-resource-card button:disabled { opacity: .55; cursor: wait; }\n.shot-render-status { display: grid; gap: 8px; margin-top: 8px; padding: 9px; border: 1px solid var(--line); border-radius: 10px; background: #f7faf8; }\n.shot-video-preview { display: block; width: min(100%, 720px); max-height: 420px; border-radius: 10px; background: #0b0e0d; }\n`;
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
await patchComponent();
await patchStyles();
await patchPackage();
console.log("Applied Alpha beta24 Local Create Video runtime");
