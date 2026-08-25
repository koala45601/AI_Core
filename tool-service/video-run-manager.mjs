import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { basename, join, resolve } from "node:path";

const ACTIVE = new Set(["starting", "preparing", "running", "stopping"]);
const MAX_LOGS = 400;

function cleanText(value, max = 4000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function safeName(value, fallback = "shot") {
  const name = cleanText(value, 100).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return name || fallback;
}

function publicRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    kind: run.kind,
    status: run.status,
    stage: run.stage,
    detail: run.detail,
    progress: run.progress,
    pid: run.pid,
    created_at: run.created_at,
    started_at: run.started_at,
    ended_at: run.ended_at,
    exit_code: run.exit_code,
    output_path: run.output_path || null,
    output_name: run.output_path ? basename(run.output_path) : null,
    logs: run.logs.slice(-MAX_LOGS),
  };
}

export function createVideoRunManager({ appDir, outputsDir, workDir }) {
  const runtimeRoot = resolve(workDir, "create-video-runtime");
  const backendDir = join(runtimeRoot, "Wan2.1-Mac");
  const venvDir = join(runtimeRoot, "venv");
  const modelDir = resolve(appDir, "models", "create-video", "Wan2.1-T2V-1.3B");
  const outputDir = resolve(outputsDir, "Create Video");
  const workerPath = resolve(appDir, "tool-service", "create-video-worker.mjs");
  const runs = new Map();

  async function exists(path) {
    return fs.access(path).then(() => true).catch(() => false);
  }

  async function diskSnapshot() {
    try {
      const stat = await fs.statfs(appDir);
      const free = Number(stat.bavail) * Number(stat.bsize);
      return { free_bytes: free, free_gb: Number((free / 1024 ** 3).toFixed(1)) };
    } catch {
      return { free_bytes: 0, free_gb: 0 };
    }
  }

  async function runtimeStatus() {
    const pythonCandidates = [
      join(venvDir, "bin", "python"),
      "/opt/homebrew/bin/python3.11",
      "/opt/homebrew/bin/python3",
      "/usr/local/bin/python3",
      "/usr/bin/python3",
    ];
    const python = (await Promise.all(pythonCandidates.map(async (path) => ({ path, ok: await exists(path) })))).find((item) => item.ok)?.path || "";
    const backendReady = await exists(join(backendDir, "generate.py"));
    const modelReady = await exists(join(modelDir, "config.json")) || await exists(join(modelDir, "Wan2.1_VAE.pth"));
    const ffmpeg = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"].find((path) => false) || "";
    const ffmpegReady = await Promise.all(["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"].map(exists)).then((values) => values.some(Boolean));
    const disk = await diskSnapshot();
    return {
      ok: true,
      backend: "wan2.1-mac-1.3b",
      local_only: true,
      paid_api_required: false,
      platform: process.platform,
      arch: process.arch,
      apple_silicon: process.platform === "darwin" && process.arch === "arm64",
      total_memory_bytes: os.totalmem(),
      total_memory_gb: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
      free_memory_bytes: os.freemem(),
      free_memory_gb: Number((os.freemem() / 1024 ** 3).toFixed(1)),
      disk,
      python,
      ffmpeg_ready: ffmpegReady,
      backend_ready: backendReady,
      model_ready: modelReady,
      generation_ready: backendReady && modelReady && Boolean(python),
      runtime_root: runtimeRoot,
      model_dir: modelDir,
      output_dir: outputDir,
      memory_strategy: "LOAD_WORK_SAVE_UNLOAD",
      profile: "M4_16GB_EXPERIMENTAL",
      note: "Wan2.1 1.3B runs locally through MPS. Rendering is free but can be slow on a fanless 16GB Mac and may use swap.",
    };
  }

  function addLog(run, stream, text) {
    const cleaned = String(text || "").replace(/[\r\n]+$/g, "").slice(0, 8000);
    if (!cleaned) return;
    run.logs.push({ at: Date.now(), stream, text: cleaned });
    if (run.logs.length > MAX_LOGS) run.logs.splice(0, run.logs.length - MAX_LOGS);
  }

  function consumeLine(run, stream, line) {
    const text = String(line || "").trim();
    if (!text) return;
    if (text.startsWith("{")) {
      try {
        const event = JSON.parse(text);
        if (event.kind === "progress") {
          run.stage = cleanText(event.stage, 120) || run.stage;
          run.detail = cleanText(event.detail, 1000) || run.detail;
          if (Number.isFinite(Number(event.progress))) run.progress = Math.max(0, Math.min(100, Number(event.progress)));
          if (event.output_path) run.output_path = resolve(String(event.output_path));
          addLog(run, "event", `${run.stage}${run.detail ? ` · ${run.detail}` : ""}`);
          return;
        }
        if (event.kind === "output" && event.path) {
          run.output_path = resolve(String(event.path));
          addLog(run, "event", `output: ${run.output_path}`);
          return;
        }
      } catch { /* normal log line */ }
    }
    addLog(run, stream, text);
  }

  function pipeLines(run, stream, readable) {
    let buffer = "";
    readable?.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() || "";
      for (const line of parts) consumeLine(run, stream, line);
    });
    readable?.on("end", () => { if (buffer) consumeLine(run, stream, buffer); });
  }

  async function stopLoadedOllama(model) {
    const name = cleanText(model, 120);
    if (!name) return;
    const candidates = ["/opt/homebrew/bin/ollama", "/usr/local/bin/ollama"];
    const ollama = (await Promise.all(candidates.map(async (path) => ({ path, ok: await exists(path) })))).find((item) => item.ok)?.path;
    if (!ollama) return;
    await new Promise((resolveStop) => {
      const child = spawn(ollama, ["stop", name], { stdio: "ignore" });
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolveStop(); }, 8000);
      child.once("close", () => { clearTimeout(timer); resolveStop(); });
      child.once("error", () => { clearTimeout(timer); resolveStop(); });
    });
  }

  async function start(input = {}) {
    const kind = input.kind === "prepare" ? "prepare" : "generate";
    const active = [...runs.values()].find((run) => ACTIVE.has(run.status));
    if (active) return publicRun(active);

    await fs.mkdir(runtimeRoot, { recursive: true });
    await fs.mkdir(modelDir, { recursive: true });
    await fs.mkdir(outputDir, { recursive: true });
    const status = await runtimeStatus();
    if (!status.apple_silicon) throw new Error("Local Video backend นี้รองรับ Apple Silicon macOS เท่านั้น");
    if (status.total_memory_bytes < 15 * 1024 ** 3) throw new Error("Unified Memory ต่ำกว่า 15GB ไม่พอสำหรับ local video profile นี้");
    if (kind === "prepare" && status.disk.free_bytes > 0 && status.disk.free_bytes < 25 * 1024 ** 3) {
      throw new Error(`พื้นที่ว่างเหลือ ${status.disk.free_gb}GB — ต้องมีอย่างน้อยประมาณ 25GB ก่อนดาวน์โหลด Local Video runtime/model`);
    }
    if (kind === "generate" && !status.generation_ready) throw new Error("Local Video Model ยังไม่พร้อม กด Prepare Local Video ก่อน");

    if (kind === "generate") await stopLoadedOllama(input.ollama_model);

    const id = randomUUID();
    const run = {
      id,
      kind,
      status: "starting",
      stage: kind === "prepare" ? "prepare_start" : "generation_start",
      detail: "",
      progress: 0,
      pid: null,
      created_at: Date.now(),
      started_at: null,
      ended_at: null,
      exit_code: null,
      output_path: null,
      logs: [],
      child: null,
    };
    runs.set(id, run);

    const args = [workerPath, kind, "--runtime-root", runtimeRoot, "--backend-dir", backendDir, "--venv-dir", venvDir, "--model-dir", modelDir, "--output-dir", outputDir];
    if (kind === "generate") {
      const prompt = cleanText(input.prompt, 6000);
      if (!prompt) throw new Error("Video Prompt ว่าง");
      const negative = cleanText(input.negative_prompt, 3000);
      const aspect = input.aspect_ratio === "9:16" ? "9:16" : "16:9";
      const quality = ["fast", "balanced", "quality"].includes(input.quality) ? input.quality : "balanced";
      const shotName = safeName(input.shot_id, "shot");
      const seed = Number.isSafeInteger(Number(input.seed)) && Number(input.seed) >= 0 ? String(Number(input.seed)) : "-1";
      args.push("--prompt", prompt, "--negative-prompt", negative, "--aspect-ratio", aspect, "--quality", quality, "--shot-id", shotName, "--seed", seed);
    }

    const child = spawn(process.execPath, args, {
      cwd: appDir,
      env: { ...process.env, PYTORCH_ENABLE_MPS_FALLBACK: "1" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    run.child = child;
    run.pid = child.pid || null;
    run.started_at = Date.now();
    run.status = kind === "prepare" ? "preparing" : "running";
    pipeLines(run, "stdout", child.stdout);
    pipeLines(run, "stderr", child.stderr);

    child.once("error", (error) => {
      run.status = "failed";
      run.stage = "process_error";
      run.detail = error.message;
      run.ended_at = Date.now();
      addLog(run, "stderr", error.message);
    });
    child.once("close", (code) => {
      run.exit_code = code ?? 1;
      run.ended_at = Date.now();
      if (run.status === "stopping") {
        run.status = "stopped";
        run.stage = "stopped";
      } else if (code === 0) {
        run.status = "completed";
        run.stage = kind === "prepare" ? "runtime_ready" : "completed";
        run.progress = 100;
      } else if (run.status !== "failed") {
        run.status = "failed";
        run.stage = "failed";
        run.detail ||= `process exited with code ${code}`;
      }
      run.child = null;
    });
    return publicRun(run);
  }

  function get(id) {
    const run = runs.get(String(id));
    if (!run) throw new Error("ไม่พบ Local Video run");
    return publicRun(run);
  }

  async function stop(id) {
    const run = runs.get(String(id));
    if (!run) throw new Error("ไม่พบ Local Video run");
    if (!ACTIVE.has(run.status) || !run.pid) return publicRun(run);
    run.status = "stopping";
    run.stage = "stopping";
    try { process.kill(-run.pid, "SIGTERM"); } catch { try { run.child?.kill("SIGTERM"); } catch {} }
    setTimeout(() => {
      if (!run.ended_at && run.pid) {
        try { process.kill(-run.pid, "SIGKILL"); } catch { try { run.child?.kill("SIGKILL"); } catch {} }
      }
    }, 2000).unref();
    return publicRun(run);
  }

  async function stopAll() {
    for (const run of runs.values()) if (ACTIVE.has(run.status)) await stop(run.id).catch(() => {});
  }

  async function file(id) {
    const run = runs.get(String(id));
    if (!run?.output_path || run.status !== "completed") throw new Error("Run นี้ยังไม่มีไฟล์วิดีโอที่พร้อมเปิด");
    const output = resolve(run.output_path);
    if (!output.startsWith(outputDir + "/")) throw new Error("ตำแหน่ง output อยู่นอก Create Video output directory");
    const stat = await fs.stat(output);
    if (!stat.isFile()) throw new Error("ไม่พบไฟล์วิดีโอ output");
    return { path: output, size: stat.size, name: basename(output) };
  }

  return { runtimeStatus, start, get, stop, stopAll, file };
}
