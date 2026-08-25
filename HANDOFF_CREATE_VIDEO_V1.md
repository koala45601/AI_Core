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

## Model / AI Configuration Guard

ในงาน Create Video:

- ห้ามเปลี่ยน Local LLM หลักโดยไม่จำเป็น
- ห้ามแก้ Ollama/model configuration เดิมเพื่อแก้ปัญหา
- ห้ามเปลี่ยน main chat prompt/model profile ถ้าไม่เกี่ยวโดยตรง
- GPT-5.6 Sol ทำหน้าที่ external reviewer/verifier จากนอก Alpha runtime ไม่ต้องเพิ่มเข้า Alpha config

Create Video Director ตอนนี้ reuse `requestChatOnce()` และ `getSettings()` ของ Alpha เดิม จึงใช้ model/config ปัจจุบันโดยไม่แก้ `lib/ollama.ts`

## Hardware Target

เครื่องเป้าหมาย:

- MacBook Air 15-inch
- Apple M4
- 16GB Unified Memory
- Apple Silicon / Metal
- Fanless

Architecture ต้องใช้แนวคิด:

`LOAD -> WORK -> SAVE -> UNLOAD`

ห้าม assume ว่า LLM + image model + video model + audio model อยู่ใน memory พร้อมกันได้

## Existing Architecture Found

- Frontend: React 19 + vinext/Vite, main shell อยู่ที่ `app/page.tsx`
- Backend/API: route handlers ใต้ `app/api/**`
- Local LLM: Ollama ผ่าน `lib/ollama.ts`
- Settings: `lib/settings-store`
- Persistent app data: D1 binding `DB` ถูกใช้อยู่แล้วใน stores เช่น memory
- Host capability plane: local Tool Service ที่ `127.0.0.1:4317`, เรียกผ่าน `lib/tool-client.ts`
- Host hardware/dependency inspection: tool `system_capability`
- Existing launcher ใช้ runtime patchers ตามลำดับ version
- Current source branchก่อน Create Video อยู่ระดับ Beta22

## What Was Implemented — Create Video Phase 1 / Beta23

งาน Phase 1 ถูกเพิ่มบน `feature/create-video-v1` โดยไม่แก้ Ticket Bot source โดยตั้งใจ

### New files

- `lib/create-video-store.ts`
  - Persistent project storage ใน D1
  - Project fields: Story, Screenplay, target duration, mode, visual settings, plan, status
  - Save/load/list project เพื่อเปิดกลับมาทำต่อหลัง browser refresh

- `lib/create-video-director.ts`
  - Reuse Local Ollama model เดิม
  - PASS 1 Story Planner
  - PASS 2 Scene-scoped Shot Planner
  - Layered context: global summary + current scene + relevant characters + location + previous shot summary
  - Character Registry
  - Location Registry
  - Character states
  - Continuity state inheritance
  - JSON parsing + Repair Pass ถ้า structured output เสีย
  - deterministic validation ของ Character/Location references
  - แบ่ง shot สั้น 2–12 วินาที แทนการสร้าง long video inference เดียว

- `app/api/create-video/route.ts`
  - `GET` list/load projects
  - `POST action=create`
  - `POST action=save`
  - `POST action=plan`
  - `POST action=hardware`
  - hardware action ใช้ `system_capability` ตรวจ Mac/dependencies
  - ไม่มีการ auto-install Video Model
  - `generation_ready: false` จนกว่าจะทำ Phase 2 จริง

- `components/create-video-studio.tsx`
  - Project UI
  - Story / Full Screenplay
  - Target Duration: 5s, 10s, 15s, 30s, 1m, 3m, 5m, custom
  - Auto Director / Manual mode
  - Style, aspect ratio, resolution, FPS, quality, seed, negative prompt
  - Project list + resume
  - Character Registry UI
  - Location Registry UI
  - Shot Cards และแก้ Action/Prompt/Duration ได้
  - Save Edited Shot Plan
  - Generate Shot button ถูก disable และระบุ Phase 2 อย่างชัดเจน
  - UI ระบุว่า Video Model ยังไม่ถูกเลือก/ติดตั้งอัตโนมัติ

- `scripts/apply-beta23-create-video.mjs`
  - patch `app/page.tsx` แบบ idempotent
  - เพิ่ม `Create Video` ใน sidebar โดยไม่ลบ Chat
  - เพิ่ม topbar label และ render `CreateVideoStudio`
  - append Create Video CSS ใน `app/globals.css`
  - bump runtime version เป็น `1.1.0-beta.23`

- `tests/beta23-create-video-phase1.test.mjs`
  - regression สำหรับ persistence, Director multi-pass, JSON repair, continuity, truthful UI, scope separation

- `.github/workflows/verify-beta23-create-video.yml`
  - apply patch
  - apply ซ้ำเพื่อเช็ก idempotency
  - focused regression
  - TypeScript typecheck
  - production build

### Modified files

- `start-alpha-v11.command`
  - เพิ่ม `apply-beta23-create-video.mjs` หลัง Beta22
  - เช็ก syntax patcher
  - launcher รอ `app_version: 1.1.0-beta.23`
  - final startup message ระบุ Create Video Phase 1

### Files intentionally NOT modified by Create Video work

- `lib/ollama.ts`
- `app/api/ticket-bot/**`
- `tool-service/ticket-run-manager.mjs`
- `templates/concert-ticket-assistant.py`
- `HANDOFF_TICKET_BOT_RUNTIME.md`

## Current Verification State

GitHub Actions workflow:

`Verify Alpha Beta23 Create Video`

ถูกสร้างและ trigger บน `feature/create-video-v1`

อย่ารายงานว่า Phase 1 ผ่านเต็มจนกว่า workflow จะผ่าน และยังต้องมี real macOS preview validation หลัง pull ลง `/Volumes/petong/Disk/AI`

CI ตรวจได้: patching, regression, typecheck, production build

CI ตรวจไม่ได้แทนเครื่องจริง: Ollama planning จริง, D1 persistence ใน live app, `system_capability` บน M4, UI interaction บน localhost

## Truthfulness / Verification Rules

ห้ามรายงานว่า video generation ใช้งานได้ใน Phase 1

Phase 1 ทำถึง:

`Story -> Director -> Registries -> Scene Plan -> Shot Plan -> Edit/Save`

ยังไม่ทำ:

`Video Model Adapter -> Local Video Backend -> Generate Clip -> FFmpeg -> Final Movie`

หลังแต่ละ Phase ต้องตรวจอย่างน้อย:

1. Build
2. Typecheck
3. Tests
4. Run application บน Mac จริง
5. Fix errors
6. Report changed files
7. Report remaining limitations

ห้าม fake generation results หรือแสดงว่า model/backend พร้อมถ้ายังไม่ได้ติดตั้ง/ทดสอบจริง

## Next Action

1. รอ/ตรวจ `Verify Alpha Beta23 Create Video`
2. ถ้า CI แดง ให้แก้เฉพาะ Create Video files/patcher; อย่าไหลไปแก้ Ticket Bot
3. เมื่อ CI เขียว ให้ pull `feature/create-video-v1` ลง Mac และเปิดด้วย `start-alpha-v11.command`
4. Real Mac smoke test:
   - sidebar มี Create Video
   - Chat เดิมยังเปิดได้
   - create project และ refresh แล้ว project ยังอยู่
   - hardware inspection แสดงผลจริง
   - run AI Director ด้วย story 1 นาที
   - ได้ Character/Location Registry และ 8–12 shots โดยประมาณ
   - แก้ shot แล้ว Save/refresh ยังอยู่
5. หลัง Phase 1 ผ่านจริง ค่อยเริ่ม Phase 2: Video Model Adapter + Resource Manager + Local Backend + Single Shot Generation
6. ก่อนเลือก/ติดตั้ง Video Model ต้องตรวจ M4/16GB, available memory, disk, Metal และ backend compatibility ก่อน ห้าม auto-install model ใหญ่
