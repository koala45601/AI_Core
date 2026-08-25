import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import os from "node:os";

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function event(stage, progress, detail = "", extra = {}) {
  process.stdout.write(JSON.stringify({ kind: "progress", stage, progress, detail, ...extra }) + "\n");
}

function output(path) {
  process.stdout.write(JSON.stringify({ kind: "output", path }) + "\n");
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolveRun() : reject(new Error(`${command} exited with code ${code}`)));
  });
}

async function exists(path) {
  return fs.access(path).then(() => true).catch(() => false);
}

async function findExecutable(candidates) {
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  return "";
}

async function freeDiskGb(path) {
  try {
    const stat = await fs.statfs(path);
    return Number(stat.bavail) * Number(stat.bsize) / 1024 ** 3;
  } catch {
    return 0;
  }
}

const kind = process.argv[2];
const runtimeRoot = resolve(arg("--runtime-root"));
const backendDir = resolve(arg("--backend-dir"));
const venvDir = resolve(arg("--venv-dir"));
const modelDir = resolve(arg("--model-dir"));
const outputDir = resolve(arg("--output-dir"));
const prompt = arg("--prompt");
const negativePrompt = arg("--negative-prompt");
const aspectRatio = arg("--aspect-ratio", "16:9");
const quality = arg("--quality", "balanced");
const shotId = arg("--shot-id", "shot");
const seed = arg("--seed", "-1");

if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Create Video local backend requires Apple Silicon macOS");
await fs.mkdir(runtimeRoot, { recursive: true });
await fs.mkdir(outputDir, { recursive: true });

async function prepare() {
  if (os.totalmem() < 15 * 1024 ** 3) throw new Error("ต้องมี Unified Memory อย่างน้อย 15GB");
  const diskGb = await freeDiskGb(runtimeRoot);
  if (diskGb && diskGb < 25) throw new Error(`พื้นที่ว่าง ${diskGb.toFixed(1)}GB ไม่พอ ต้องมีอย่างน้อยประมาณ 25GB`);

  const git = await findExecutable(["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"]);
  if (!git) throw new Error("ไม่พบ git บน Mac");
  const brew = await findExecutable(["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]);
  let python = await findExecutable(["/opt/homebrew/bin/python3.11", "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"]);
  let ffmpeg = await findExecutable(["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]);

  if ((!python || !ffmpeg) && brew) {
    const packages = [];
    if (!python) packages.push("python@3.11");
    if (!ffmpeg) packages.push("ffmpeg");
    if (packages.length) {
      event("install_dependencies", 5, `ติดตั้ง ${packages.join(", ")} ด้วย Homebrew`);
      await run(brew, ["install", ...packages]);
      python = await findExecutable(["/opt/homebrew/bin/python3.11", "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"]);
      ffmpeg = await findExecutable(["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]);
    }
  }
  if (!python) throw new Error("ไม่พบ Python 3.10+ และไม่สามารถติดตั้งอัตโนมัติได้");
  if (!ffmpeg) throw new Error("ไม่พบ FFmpeg และไม่สามารถติดตั้งอัตโนมัติได้");

  if (!await exists(join(backendDir, "generate.py"))) {
    event("download_backend", 12, "ดาวน์โหลด Wan2.1-Mac backend");
    await fs.rm(backendDir, { recursive: true, force: true });
    await run(git, ["clone", "--depth", "1", "https://github.com/HighDoping/Wan2.1-Mac.git", backendDir], { cwd: runtimeRoot });
  } else {
    event("download_backend", 18, "Wan2.1-Mac backend มีอยู่แล้ว");
  }

  const venvPython = join(venvDir, "bin", "python");
  if (!await exists(venvPython)) {
    event("python_env", 22, "สร้าง Python virtual environment");
    await run(python, ["-m", "venv", venvDir]);
  }
  event("python_packages", 30, "ติดตั้ง local video Python dependencies");
  await run(venvPython, ["-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"]);
  await run(venvPython, ["-m", "pip", "install", "-r", join(backendDir, "requirements.txt")], { cwd: backendDir });
  await run(venvPython, ["-m", "pip", "install", "einops", "huggingface_hub"]);

  if (!await exists(join(modelDir, "config.json")) && !await exists(join(modelDir, "Wan2.1_VAE.pth"))) {
    event("download_model", 55, "ดาวน์โหลด Wan2.1 T2V 1.3B model ครั้งแรก — ใช้พื้นที่และเวลา แต่ไม่เสียค่า API");
    await fs.mkdir(modelDir, { recursive: true });
    const script = [
      "from huggingface_hub import snapshot_download",
      "snapshot_download(repo_id='Wan-AI/Wan2.1-T2V-1.3B', local_dir=r'''" + modelDir.replaceAll("'", "\\'") + "''', local_dir_use_symlinks=False)",
    ].join("\n");
    await run(venvPython, ["-c", script]);
  } else {
    event("download_model", 85, "Local Video Model มีอยู่แล้ว ไม่ดาวน์โหลดซ้ำ");
  }

  event("verify_runtime", 92, "ตรวจ MPS / backend / model");
  const verifyScript = "import torch; print('mps_available=', torch.backends.mps.is_available())";
  await run(venvPython, ["-c", verifyScript], { env: { PYTORCH_ENABLE_MPS_FALLBACK: "1" } });
  event("runtime_ready", 100, "Local Wan2.1 1.3B พร้อมสร้างวิดีโอแบบ local ฟรี");
}

function generationProfile() {
  if (quality === "fast") return { frameNum: 17, steps: 12, tile: 192 };
  if (quality === "quality") return { frameNum: 49, steps: 30, tile: 256 };
  return { frameNum: 33, steps: 20, tile: 256 };
}

async function generate() {
  const venvPython = join(venvDir, "bin", "python");
  if (!await exists(venvPython) || !await exists(join(backendDir, "generate.py"))) throw new Error("Local Video runtime ยังไม่พร้อม");
  if (!await exists(join(modelDir, "config.json")) && !await exists(join(modelDir, "Wan2.1_VAE.pth"))) throw new Error("Local Video model ยังไม่พร้อม");
  if (!prompt.trim()) throw new Error("Video Prompt ว่าง");

  const profile = generationProfile();
  const size = aspectRatio === "9:16" ? "480*832" : "832*480";
  const fileName = `${shotId}-${Date.now()}.mp4`;
  const saveFile = join(outputDir, fileName);
  const fullPrompt = negativePrompt.trim()
    ? `${prompt.trim()}\nNegative prompt: ${negativePrompt.trim()}`
    : prompt.trim();

  event("unload_llm", 3, "LLM ถูกปล่อยจาก memory ก่อน local video inference");
  event("load_video_model", 8, `โหลด Wan2.1 1.3B ผ่าน MPS · ${size} · ${profile.frameNum} frames`);
  const args = [
    join(backendDir, "generate.py"),
    "--task", "t2v-1.3B",
    "--size", size,
    "--frame_num", String(profile.frameNum),
    "--sample_steps", String(profile.steps),
    "--ckpt_dir", modelDir,
    "--tile_size", String(profile.tile),
    "--offload_model", "True",
    "--t5_quant",
    "--device", "mps",
    "--prompt", fullPrompt,
    "--save_file", saveFile,
  ];
  if (Number(seed) >= 0) args.push("--base_seed", seed);
  event("rendering", 15, "กำลัง render shot บน Apple Silicon — ขั้นตอนนี้อาจใช้เวลาหลายนาที");
  await run(venvPython, args, {
    cwd: backendDir,
    env: { PYTORCH_ENABLE_MPS_FALLBACK: "1", PYTHONUNBUFFERED: "1" },
  });
  if (!await exists(saveFile)) throw new Error("Backend จบแล้วแต่ไม่พบไฟล์ MP4 output");
  event("save_clip", 95, "บันทึก local MP4 แล้ว", { output_path: saveFile });
  output(saveFile);
  event("unload_video_model", 99, "Video process จบแล้ว memory จะถูกคืนเมื่อ process exit");
  event("completed", 100, "Shot พร้อมใช้งาน", { output_path: saveFile });
}

if (kind === "prepare") await prepare();
else if (kind === "generate") await generate();
else throw new Error(`unknown worker kind: ${kind}`);
