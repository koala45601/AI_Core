# Alpha Create Video v1 — Handoff / Scope Guard

## Purpose

เอกสารนี้ใช้แยกงาน **Create Video / Local AI Film Studio** ออกจากงาน Ticket Bot ที่กำลังค้างอยู่ เพื่อไม่ให้ ChatGPT/Codex รอบถัดไปสับสนหรือแก้ข้าม scope

## Branches

- `backup/before-create-video-20260826` — snapshot branch ก่อนเริ่มงาน Create Video
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
- Ticket Bot tests / patchers / launcher wiring ที่เกี่ยวกับ Beta21
- concert ticket learned skill/runtime

ถ้ามีไฟล์เหล่านี้แสดง modified ใน working tree ให้ถือว่าเป็น **pre-existing WIP** และห้าม overwrite/revert/reset โดยงาน Create Video

## Current Local Working Tree Warning

ก่อนเริ่ม Create Video มีงาน Ticket Bot/WIP ที่ยังไม่ได้ commit อยู่ในเครื่อง และมี generated build artifacts (`dist/...`) ที่ถูกลบ/แก้จำนวนมาก รวมถึงมี untracked file ที่เห็นจากสถานะล่าสุด เช่น:

- `lib/ticket-event-cache.ts`

ดังนั้น branch ที่ push ขึ้น Git อย่างเดียวอาจยังไม่เท่ากับ snapshot ของ working tree ในเครื่องจนกว่าจะมีการ commit WIP backup อย่างถูกต้อง

ห้ามใช้ `git reset --hard`, `git clean -fd`, checkout ทับไฟล์ WIP, หรือการ restore แบบกว้าง ๆ ระหว่างทำ Create Video

## Create Video Requirements Source

งานใหม่ต้องยึด requirement จากเอกสารที่ผู้ใช้ให้ชื่อโดยประมาณ:

`Build Create Video Mode for My Existing Local AI Web App`

เป้าหมายคือเพิ่มเมนู **Create Video** เข้า Web App เดิมที่ `localhost:3000` และพัฒนาให้เป็น local AI film studio โดยไม่สร้าง application ใหม่และไม่ทำลาย Chat Mode เดิม

## Model / AI Configuration Guard

ในงาน Create Video รอบนี้:

- ห้ามเปลี่ยน Local LLM หลักโดยไม่จำเป็น
- ห้ามแก้ Ollama/model configuration เดิมเพื่อแก้ปัญหา
- ห้ามเปลี่ยน main chat prompt/model profile ถ้าไม่เกี่ยวโดยตรง
- GPT-5.6 Sol ทำหน้าที่ external reviewer/verifier จากนอก Alpha runtime ไม่ต้องเพิ่มเข้า Alpha config

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

## Implementation Order

เริ่มจาก **Inspect Existing Project ก่อนเสมอ**:

1. Frontend framework
2. Backend architecture
3. Ollama integration
4. Model/resource manager
5. Hardware/resource detection
6. Routing / state management / storage / API
7. Existing reusable components
8. FFmpeg availability
9. Apple Silicon / Metal support
10. Current dependencies

ก่อนแก้ code ให้สรุปสั้น ๆ:

- Existing Architecture
- Relevant Files
- Implementation Plan
- New Files
- Modified Files
- Hardware Risks

จากนั้นทำแบบ incremental ตาม phase:

- Phase 1: Create Video UI, project storage, Director, shot planner, character/location/continuity registry, shot cards
- Phase 2: Video model adapter, generation queue, local backend, single-shot generation
- Phase 3: Long video, FFmpeg, resume, regenerate
- Phase 4: Storyboard, voice/audio/subtitle, advanced continuity

## Truthfulness / Verification Rules

ห้ามรายงานว่า feature ใช้งานได้จาก fixture/build อย่างเดียว

หลังแต่ละ phase ต้องตรวจอย่างน้อย:

1. Build
2. Typecheck (ถ้ามี)
3. Tests
4. Run application
5. Fix errors
6. Report changed files
7. Report remaining limitations

ห้าม fake generation results หรือแสดงว่า model/backend พร้อมถ้ายังไม่ได้ติดตั้ง/ทดสอบจริง

## What Has Been Done So Far

ณ ตอนสร้าง handoff นี้:

- สร้าง backup branch สำหรับสถานะก่อน Create Video แล้ว
- สร้าง `feature/create-video-v1` สำหรับแยกงาน Create Video แล้ว
- ยัง **ไม่ได้เริ่ม implementation Create Video จริง**
- ยัง **ไม่ได้เปลี่ยน AI/Ollama/model config เดิม**
- งาน Ticket Bot/Beta21 ต้องถูก preserve และปล่อยให้ Codex ทำต่อแยกภายหลัง

## Next Action

ก่อนเริ่มแก้ Create Video ให้ตรวจสถานะ Git/local working tree อีกครั้ง และทำให้แน่ใจว่า pre-existing Ticket Bot WIP ถูก backup โดยไม่สูญหาย จากนั้นจึง inspect architecture และเริ่ม Phase 1 โดยแก้เฉพาะไฟล์ที่จำเป็นกับ Create Video
