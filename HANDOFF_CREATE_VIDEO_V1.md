# Alpha Create Video v1 — Handoff / Scope Guard

## Purpose

เอกสารนี้ใช้แยกงาน **Create Video / Local AI Film Studio** ออกจากงาน Ticket Bot ที่กำลังค้างอยู่ เพื่อไม่ให้ ChatGPT/Codex รอบถัดไปสับสนหรือแก้ข้าม scope

## Branches

- `backup/before-create-video-20260826` — snapshot branch ก่อนเริ่มงาน Create Video
- `wip/ticket-bot-local-20260826` — ใช้เก็บ local Ticket Bot WIP ก่อนแยกงาน (ถ้าผู้ใช้ push ตามคำสั่งแล้ว)
- `feature/create-video-v1` — branch สำหรับงาน Create Video เท่านั้น
- `fix/ticket-studio-build-readiness-v1` — งาน Ticket Bot/Beta21 เดิม ให้ Codex กลับไปทำต่อภายหลัง

## CRITICAL: DO NOT TOUCH TICKET BOT

งาน Create Video ห้ามแก้/cleanup/refactor งาน Ticket Bot ที่ยังค้างอยู่ เว้นแต่ผู้ใช้สั่งโดยตรงภายหลัง

โดยเฉพาะอย่าแก้โดยตั้งใจใน scope นี้:

- `HANDOFF_TICKET_BOT_RUNTIME.md`
- `app/api/ticket-bot/**`
- `tool-service/ticket-run-manager.mjs`
- Ticket Bot runtime / Ticket Studio UI
- `templates/concert-ticket-assistant.py`
- Ticket Bot tests / patchers / launcher wiring ที่เกี่ยวกับ Beta21/Beta22
- concert ticket learned skill/runtime

ถ้ามีไฟล์เหล่านี้แสดง modified ใน working tree ให้ถือว่าเป็น **pre-existing WIP** และห้าม overwrite/revert/reset โดยงาน Create Video

## Current Local Working Tree Warning

ก่อนเริ่ม Create Video มีงาน Ticket Bot/WIP ที่ยังไม่ได้ commit อยู่ในเครื่อง และมี generated build artifacts (`dist/...`) ที่ถูกลบ/แก้จำนวนมาก รวมถึงเคยมี untracked file เช่น `lib/ticket-event-cache.ts`

ห้ามใช้ `git reset --hard`, `git clean -fd`, checkout ทับไฟล์ WIP, หรือ restore แบบกว้าง ๆ ระหว่างทำ Create Video

## Create Video Requirements Source

งานใหม่ยึด requirement จากเอกสารผู้ใช้:

`Build Create Video Mode for My Existing Local AI Web App`

เป้าหมายคือเพิ่มเมนู **Create Video** เข้า Web App เดิมที่ `localhost:3000` และพัฒนาให้เป็น local AI film studio โดยไม่สร้าง application ใหม่และไม่ทำลาย Chat Mode เดิม

ผู้ใช้ยืนยันเพิ่มเติมว่า **Alpha ต้อง Generate Video เองแบบ Local** ไม่ใช่ให้ Copy Prompt ไปใช้ paid external video service

## Model / AI Configuration Guard

ในงาน Create Video:

- ห้ามเปลี่ยน Local LLM หลักโดยไม่จำเป็น
- ห้ามแก้ Ollama/model configuration เดิมเพื่อแก้ปัญหา
- ห้ามเปลี่ยน main chat prompt/model profile ถ้าไม่เกี่ยวโดยตรง
- GPT-5.6 Sol ทำหน้าที่ external reviewer/verifier จากนอก Alpha runtime ไม่ต้องเพิ่มเข้า Alpha config

Create Video Director reuse `requestChatOnce()` และ `getSettings()` ของ Alpha เดิม จึงใช้ model/config ปัจจุบันโดยไม่แก้ `lib/ollama.ts`

ก่อน Local Video inference Beta24 จะสั่ง `ollama stop <configured model>` เพื่อคืน Unified Memory และเมื่อ Director/Chat ถูกเรียกอีกครั้ง Ollama จะโหลด model กลับตาม flow เดิม

## Hardware Target

เครื่องเป้าหมาย:

- MacBook Air 15-inch
- Apple M4
- 16GB Unified Memory
- Apple Silicon / Metal
- Fanless

Architecture ใช้:

`LOAD -> WORK -> SAVE -> UNLOAD`

ห้าม assume ว่า LLM + image model + video model + audio model อยู่ใน memory พร้อมกันได้

## Existing Architecture Found

- Frontend: React 19 + vinext/Vite, main shell อยู่ที่ `app/page.tsx`
- Backend/API: route handlers ใต้ `app/api/**`
- Local LLM: Ollama ผ่าน `lib/ollama.ts`
- Settings: `lib/settings-store`
- Persistent app data: D1 binding `DB`
- Host capability plane: local Tool Service ที่ `127.0.0.1:4317`, เรียกผ่าน `lib/tool-client.ts`
- Host hardware/dependency inspection: tool `system_capability`
- Existing launcher ใช้ runtime patchers ตามลำดับ version
- Create Video source เริ่มจาก Beta22 และ Phase 1 เป็น Beta23

## Implemented — Phase 1 / Beta23

### New files

- `lib/create-video-store.ts`
  - Persistent project storage ใน D1
  - Story, Screenplay, duration, mode, visual settings, plan, status
  - Save/load/list project

- `lib/create-video-director.ts`
  - Local Ollama Director
  - PASS 1 Story Planner
  - PASS 2 Scene-scoped Shot Planner
  - Layered context
  - Character Registry / Location Registry / Character states
  - Continuity inheritance
  - JSON parse + Repair Pass
  - deterministic Character/Location validation
  - shot 2–12 วินาที

- `app/api/create-video/route.ts`
  - project create/save/plan/hardware

- `components/create-video-studio.tsx`
  - Project UI
  - Story / Full Screenplay
  - Duration / Style / Ratio / Resolution / FPS / Quality / Seed / Negative Prompt
  - Director/Shot Plan/Registries
  - Shot editor + save

- `scripts/apply-beta23-create-video.mjs`
  - add Create Video to existing sidebar and CSS
  - runtime beta23

- `tests/beta23-create-video-phase1.test.mjs`

## Implemented — Phase 2 Local Renderer / Beta24

Beta24 เปลี่ยน flow จาก

`Director -> Video Prompt -> copy ไปที่อื่น`

เป็น

`Director -> Video Prompt -> Alpha Local Video Runtime -> MP4 Shot`

### Local backend

เลือก backend เริ่มต้นเป็น **Wan2.1 T2V 1.3B สำหรับ Mac/MPS** โดยใช้ Mac-oriented backend repository `HighDoping/Wan2.1-Mac`.

เหตุผล:

- เป็น local/open model ไม่ต้องใช้ paid API
- รองรับ Apple Silicon/MPS
- 1.3B เหมาะกว่า 14B สำหรับ M4 16GB
- backend มี model offload, quantized T5 และ VAE tiling เพื่อลด memory pressure

**หมายเหตุสำคัญ:** M4 16GB ถือเป็น experimental/minimum profile. การ render อาจช้ามากและใช้ swap โดยเฉพาะ quality profile. ห้ามรายงานว่าเร็วหรือรับประกันทุก prompt จนกว่าจะทดสอบ Mac จริง

### New files Beta24

- `tool-service/video-run-manager.mjs`
  - async prepare/generate jobs
  - one heavy local video job at a time
  - progress/log/status/PID/output
  - stop owned process group
  - output path guard ใต้ `outputs/Alpha Outputs/Create Video`
  - inspect Apple Silicon / RAM / free disk / runtime/model readiness
  - requireประมาณ 25GB free disk ก่อน first model setup
  - stop configured Ollama model before rendering
  - `LOAD_WORK_SAVE_UNLOAD`

- `tool-service/create-video-worker.mjs`
  - first-time bootstrap แบบ local
  - ตรวจ/ติดตั้ง Python 3.11 และ FFmpeg ด้วย Homebrew ถ้าขาดและ Homebrew มีอยู่
  - clone `HighDoping/Wan2.1-Mac`
  - สร้าง isolated venv ใต้ `work/create-video-runtime`
  - install Python dependencies
  - download `Wan-AI/Wan2.1-T2V-1.3B` ลง `models/create-video/...`
  - run Wan through MPS
  - render profiles:
    - fast: 17 frames / 12 steps
    - balanced: 33 frames / 20 steps
    - quality: 49 frames / 30 steps
  - save MP4 ใต้ Create Video output directory

- `scripts/apply-beta24-create-video-local.mjs`
  - patch Tool Service with `/v1/video-*` endpoints
  - patch Create Video UI with Prepare Local Video / Copy Prompt / Generate Shot Local / Stop / preview
  - patch CSS
  - runtime version `1.1.0-beta.24`

- `tests/beta24-create-video-local.test.mjs`

- `.github/workflows/verify-beta24-create-video-local.yml`

### Modified Beta24

- `lib/tool-client.ts`
  - `getVideoRuntimeStatus`
  - `startVideoRun`
  - `getVideoRun`
  - `stopVideoRun`
  - `videoRunFileResponse`

- `app/api/create-video/route.ts`
  - `runtime_status`
  - `prepare_local_video`
  - `generate_shot`
  - `run_status`
  - `run_stop`
  - MP4 proxy preview
  - passes configured Ollama model only for memory release; does not change model config

- `start-alpha-v11.command`
  - apply Beta24 after Beta23
  - syntax-check local video manager/worker
  - waits for `1.1.0-beta.24`

### UI flow Beta24

1. ใส่บทเต็มใน Full Screenplay
2. Create Project
3. `AI Director: Generate Shot Plan`
4. ครั้งแรกกด `Prepare Local Video — ฟรี`
5. รอ backend + venv + Wan2.1 model download/prepare จบ
6. แต่ละ Shot กด `Generate Shot · Local`
7. Alpha unloads Ollama model -> runs Wan/MPS -> saves MP4 -> shows preview
8. `Copy Prompt` ยังมีไว้สำหรับ debug/manual แต่ไม่ใช่ workflow หลัก

## Still NOT Implemented

Beta24 ทำ **single-shot local generation** แล้ว แต่ยังไม่ครบ final film pipeline:

- Generate All Shots queue แบบอัตโนมัติ
- persist mapping Shot -> generated clip หลัง restart
- regenerate/variant history
- image/reference conditioning เพื่อ character consistency สูงขึ้น
- FFmpeg timeline assembly ของทุก shot เป็น final movie
- dialogue/TTS
- SFX/music generation/mix
- subtitle/text overlay
- final 5-minute export
- pause/resume queue across Alpha restart

สิ่งเหล่านี้เป็น Phase 3/4 ต่อไป

## Files Intentionally NOT Modified by Create Video Work

- `lib/ollama.ts`
- `app/api/ticket-bot/**`
- `tool-service/ticket-run-manager.mjs`
- `templates/concert-ticket-assistant.py`
- `HANDOFF_TICKET_BOT_RUNTIME.md`

`tool-service/server.mjs` ถูก Beta24 patcher เพิ่มเฉพาะ `/v1/video-*` endpoints และ shutdown cleanup เท่านั้น ห้ามใช้โอกาสนี้ refactor Ticket Bot routes

## Verification

### Beta23

`Verify Alpha Beta23 Create Video` เคยผ่านสำหรับ Phase 1 ที่ commit `66d849bf912ba1c003bf6a391dcfaa8719ade01d`.

### Beta24

Workflow: `Verify Alpha Beta24 Local Create Video`

CI ตรวจได้:

1. Beta23 -> Beta24 patch order
2. patch idempotency
3. Node syntax
4. static/local runtime regression
5. focused TypeScript errors
6. production build

CI **ไม่สามารถ** ยืนยัน MPS/Wan render จริงเพราะ GitHub runner เป็น Linux

Mac E2E ที่ต้องทำหลัง CI ผ่าน:

1. pull `feature/create-video-v1`
2. launch `start-alpha-v11.command`
3. Create Video ต้องขึ้น Beta24
4. hardware/runtime status ต้องเห็น Apple Silicon/M4
5. `Prepare Local Video — ฟรี`
6. model/backend ต้อง download จบและ `generation_ready=true`
7. สร้าง Project + Director Shot Plan
8. Generate Shot local 1 shot ด้วย `fast` ก่อน
9. ต้องได้ MP4 จริงและเล่น preview ได้
10. ตรวจ Activity Monitor ว่า Ollama ถูก unload ก่อน render และ process video คืน memory หลังเสร็จ
11. ทดสอบ Stop ระหว่าง render
12. ทดสอบ restart Alpha แล้ว runtime/model ไม่ download ซ้ำ

ห้ามอ้างว่า Mac local render ผ่านจริงจนกว่าจะทำรายการนี้บนเครื่องผู้ใช้

## Truthfulness Rules

- ไม่มี paid video API ใน Beta24 generation path
- ห้าม fake MP4/result
- ถ้า Wan/MPS ติดตั้งหรือ render fail ให้แสดง error/log จริง
- ห้าม fallback ไป cloud/paid API โดยอัตโนมัติ
- ห้ามเปลี่ยน qwen/Ollama config เพื่อให้ video ทำงาน
- ห้ามทำ Ticket Bot cleanup ใน branch นี้
