# Alpha changelog

## 1.1.0-beta.24 — 2026-08-26

- Ticket discovery now performs one listing navigation instead of immediately opening every event detail page.
- Event details are inspected only after selection and repeated clicks reuse an in-flight result for a short cooldown.
- Public inspection and live Ticket Bot runs use separate persistent browser profiles instead of disposable profiles on every run.
- Passive API evidence is read from the already-open page; selecting an event no longer opens a second page or sends automatic OPTIONS probes.
- Only one live Ticket Bot may own the persistent ticket session at a time, preventing competing windows and duplicate runs.
- Invalid booking-host fallbacks for `/concert/*` pages were removed, so one rejected page no longer produces another rejected tab.
- macOS Chrome now keeps its native sandbox and drops Playwright's automation banner flags; a denied public page is closed immediately and returned as a structured server denial instead of being left as an apparent successful inspection.
- ThaiTicketMajor's official booking index is selected before listing inspection, avoiding a known denied marketing-host navigation instead of failing first and retrying afterward.
- Public event details now use the direct HTML reader for dates, venue, prices and sale status, so selecting or rechecking KITA does not open an automated Chrome tab.
- Explicit `Ticket Status SOLD OUT` is classified separately from a generally closed sale; live checks now distinguish open, upcoming, sold-out and closed official pages.

## 1.1.0-beta.23 — 2026-08-25

- “ตรวจคอนเสิร์ต” refreshes each open/upcoming event once, stores announced show dates plus queue/sale times in D1, and reuses that session cache until the user explicitly refreshes again.
- Multi-day events require a saved day/round selection before build; the generated bot keeps that exact selection through the same waiting-room session and never falls back to another day silently.
- Recognizes the real visible ThaiTicketMajor `เลือกรอบ/ประเภทบัตร` control as sale entry and activates it during a live run.
- Inspect-only keeps the visible isolated Chrome window open for review and reports `INSPECTION_ONLY_NOT_FULL_LOOP` instead of completion.
- A zero-exit process without verified `PAYMENT_HANDOFF` is reported as `not_verified`, never `completed`.
- Ticket Studio shows a readable action timeline and separates Fixture, live runtime, and verified Full Loop states.
- The browser remains visible without moving the system mouse; API observations and DOM actions are surfaced as runtime evidence.

## 1.1.0-beta.21 — 2026-08-25

- Added a real Ticket Run Manager: build success can start the generated Ticket Bot process instead of stopping at fixture verification.
- Added local-only start/status/input/stop runtime endpoints with Program_Create realpath validation, symlink protection, single-active-run reuse, bounded redacted logs, and owned process-group cleanup.
- Ticket Bot Studio now accepts ephemeral login credentials, starts the real runtime after build, polls live run status every second, surfaces CAPTCHA/OTP/manual input handoffs, and can stop the owned run.
- Generated bots emit structured input_required JSONL before blocking on stdin so the UI can explain exactly what the process is waiting for.
- Fixture success is no longer presented as Full Loop success; PAYMENT_HANDOFF requires runtime evidence.

## 1.1.0-beta.22 — 2026-08-25

- Repeated concert inspection and build/run clicks are serialized immediately in the UI, while the API reuses the same passive browser page and in-flight inspection instead of opening duplicate tabs or processes.
- Passive inspection blocked by the public site now returns a truthful `runtime_discovery_required` result instead of surfacing an unhandled 500 error.
- The launcher synchronizes the installed learned Ticket skill with the beta.22 generator, generated projects record their generator version, and stale/failed projects are rebuilt instead of silently rerun.
- Repeated Run requests for the same active project reuse one run id and PID; stopped or failed runs retain their real result and reason.
- Ticket Bot queue entry now requires a visible, enabled control; instructional copy containing “รับคิว” can no longer produce a false waiting-room state.
- Active queue detection now requires explicit queue-progress evidence and no longer treats generic waiting-room wording as proof.
- Purchase entry requires a visible, enabled control instead of incidental “ซื้อบัตร” text in event instructions.
- Ticket-selection state now requires visible seat/zone/quantity controls; event copy containing “เลือกที่นั่ง” is not accepted as live seat inventory evidence.
- Ticket Studio labels fixture-only builds as `Fixture เท่านั้น`; only runtime `PAYMENT_HANDOFF` evidence may display `Full Loop ผ่าน`.
- Generated bots keep the same browser session alive before queue/sale opening, use bounded waits, and recover if a verified control disappears before click.
- Added generated fixture coverage for hidden/instructional queue and purchase copy.

## 1.1.0-beta.20 — 2026-08-25

- ตั้งชื่อโฟลเดอร์โปรเจกต์บอทให้อัตโนมัติจาก URL ของคอนเสิร์ต ผู้ใช้ไม่ต้องคิดชื่อเอง
- แสดงพาธปลายทางจริงก่อนสร้าง และย้ายการแก้ชื่อเองไว้ใต้ตัวเลือกขั้นสูงที่ไม่บังคับ
- เปลี่ยนคอนเสิร์ตแล้วจะสร้างชื่อใหม่ให้ทันที; โฟลเดอร์เดิมยังไม่ถูกเขียนทับและระบบเติมเลขท้ายเมื่อชื่อซ้ำ

## 1.1.0-beta.19 — 2026-08-25

- เลือกคอนเสิร์ตและสร้างบอทได้ทันที ไม่บังคับให้ public detail inspection ผ่านก่อน
- เมื่อเว็บบล็อกหน้ารายละเอียด โปรแกรมที่สร้างจะค้นรอบ โซน และฟอร์มจริงหลัง Login ตอนรัน
- งบสูงสุดเป็นตัวเลือกเสริม; ค่า 0 หมายถึงไม่จำกัดงบ
- แสดงและกรองสถานะ Open, Upcoming, SOLD OUT, Closed, Ended, Cancelled และ Unknown พร้อมจำนวนศูนย์
- แยก “ช่วงขายเปิดแล้ว” ออกจาก “มีที่นั่งว่าง”: หน้ารวมไม่ถูกใช้ยืนยัน inventory และ UI แจ้งชัดว่าต้อง Login เข้าโซน/ผังที่นั่งจริง
- ย้าย public inspection/API discovery ไปเบื้องหลังแบบ headless และปิดหน้าตรวจชั่วคราว ไม่ทิ้งแท็บ Access Denied

## 1.1.0-beta.18 — 2026-08-25

- Public concert discovery now detects a ThaiTicketMajor homepage `Access Denied` response and retries the official `booking.thaiticketmajor.com` public listing without requiring Login.
- Ticket Studio now shows open, upcoming, sold-out, closed, ended, cancelled and unknown states separately; only open/upcoming records can be selected.
- Reserved-seat configuration no longer forces users to guess zone names. It displays discovered A/A1/A2-style zones when available and otherwise asks after Login on the live zone page.
- Added preferred row, seat number/range and exact/nearest/same-zone fallback controls. A requested zone is never silently changed and multi-ticket fallback never mixes zones.
- Generated Full Loop programs must verify an existing authenticated account marker or a successful Login-form transition before Checkout or QR handoff. Public inspection remains login-free and passwords are never persisted.
- Added regression coverage for official public fallback, sale-state labels, zone/row discovery, deferred zone choice, exact seat targeting and Login gating.

## 1.1.0-beta.17 — 2026-08-25

- Verified one live ThaiTicketMajor flow through login, event terms, image-map zone B, quantity, event-specific attendee name, pickup, QR selection and the final KBank PromptPay page without submitting payment.
- Fixed the false-positive checkout bug where QR/payment wording in an event's terms page was incorrectly classified as a completed payment handoff.
- Added deterministic states for server-side close-sale, login, terms, zone selection, quantity selection, attendee details, checkout options and final QR payment evidence.
- Final checkout now requires at least three independent signals, including the KBank QR path/frame, step 4/4, order identity, countdown and PromptPay/ThaiQR content.
- Generated ticket projects now include `run-full-loop.command`, secure environment/terminal credential entry, image-map zone selection, optional event-specific attendee names, pickup/postal choice and Ticket Protect control.
- Ticket Studio no longer requires address/name fields for every concert; it asks only when the selected delivery method or live event form needs them.
- Added generated-project regression tests based on the observed ThaiTicketMajor paths and state transitions.

## 1.1.0-beta.16 — 2026-08-24

- Replaced the Ticket Bot's unconditional `CHECKOUT_READY` output with an evidence-backed state machine. Unknown pages can no longer be reported as checkout success.
- Added deterministic extraction of Thai Buddhist show/sale dates, venue, prices, sale status and semantic purchase controls from the live event page; missing sale time is never replaced with project build time.
- Added separate `queueOpenAt` and `saleOpenAt` settings for events whose waiting room opens before ticket sales.
- Generated projects now include state-machine source, retained fixtures, a verification report and a JSONL live run journal. The API requires all eight project files and passing fixture evidence before returning success.
- Added fixtures for waiting rooms, Retry-After, 429/503 outages, same-session recovery, login/CAPTCHA/OTP/payment handoff, reserved/general-admission tickets and multiple-ticket selection.
- Split verification into structure, fixture tests, public live-page inspection, live queue observation and live checkout evidence. A fixture pass no longer claims a real queue or purchase was tested.
- Ticket Studio and chat now carry the same page facts and preflight state; the UI is optional rather than a smarter execution path.
- Split upcoming sales into `pre_sale` (more than 30 minutes away) and `armed_pre_sale` (within 30 minutes), using the website sale timestamp plus the HTTP `Date` header before falling back to the Mac clock.
- Treat verified performance-time links such as `19:00` as sale-entry controls, expose the discovered rounds in Ticket Studio, and keep the same browser session after Login/CAPTCHA/OTP handoff instead of exiting the workflow.
- Ticket automation now uses an isolated background Chrome window and DOM/API actions without controlling the system mouse; the window is only handed to the user at Login/CAPTCHA/OTP/payment checkpoints.
- Preferred ticket zones are normalized to uppercase in the UI, API, generated config and seat-selection runtime. Multi-ticket `any` selection remains restricted to one zone.
- Ticket-skill verification now builds and runs nested Python fixtures on the container-local temporary filesystem before copying the verified project to an external drive, avoiding Docker Desktop visibility races on `/Volumes/...`.
- Core-skill installation prints the exact failed fixture, stdout/stderr and missing outputs instead of stopping with only `test criteria not met`.
- The Beta16 launcher now waits for the real `http://localhost:3000/api/health` response before reporting that Alpha is ready.

## 1.1.0-beta.15 — 2026-08-24

- Added Ticket Bot Studio as a fixed-height workspace with internal scrolling for event discovery, concert selection, reserved/standing ticket preferences, buyer address, and QR/PromptPay handoff settings.
- Added a deterministic `/api/ticket-bot` Full Loop that inspects open/upcoming events, reads page controls, captures passive fetch/XHR evidence, runs the verified ticket-project skill, and validates the five generated project files without making a live purchase.
- Improved public event extraction by merging duplicate URLs, preferring structured names, and filtering generic navigation/button entries such as “คอนเสิร์ต” and “ซื้อบัตร”.
- Verified the read-only discovery flow against multiple current ThaiTicketMajor concert pages and generated retained dry-run projects for both reserved seating and standing tickets.
- Internet and domain settings remain authoritative; the UI reports the exact capability or allowlist issue instead of silently failing.

## 1.1.0-beta.14 — 2026-08-24

- Fixed the adaptive-reasoning runtime patch that referenced `deepWorker` before initialization and prevented every autonomous skill build.
- Added repeated-pipeline and infrastructure-failure circuit breakers so unlimited Auto Learn moves to another topic instead of retrying one broken method forever.
- Deferred failed backlog items with bounded exponential backoff while preserving their checkpoints and error history.
- Refreshes the Skills registry as soon as Auto Learn installs a verified skill.
- Added three verified operational skills: authorized API traffic analysis, macOS/system capability mapping and cybersecurity risk prioritization.
- Added dual-runtime learned skills that can run in Docker or directly on macOS when Full local access is enabled, with the execution target recorded in each result.
- Added schema-constrained skill planning/building, resilient JSON extraction, bounded non-thinking workers, and actual stdout diagnostics so a failed attempt can repair the candidate instead of repeating it blindly.
- Added verified Web API contract discovery and a macOS-host Python/Playwright concert-ticket project builder that supports reserved seating and standing tickets, creates unique projects under `Program_Create`, respects queues, and hands control to the user for login, CAPTCHA, OTP, and payment.
- Fixed the preview launcher so Beta13, Auto Learn recovery, and the ticket workflow are applied in order; the five core Beta14 skills are installed only when missing rather than retested on every start.

## 1.1.0-beta.13 — 2026-08-24

- Fixed the 30–60 second composer lock after visible answer completion. The chat stream now finishes immediately after the assistant message and Artifact state are persisted.
- Moved durable-memory extraction and rolling-summary generation to a separate idle post-processing request instead of keeping the user-facing SSE response open.
- Added an 8-second idle grace period and cancellation: a new user question cancels pending/in-flight post-processing so interactive chat takes priority over utility model work.
- Preserved automatic memory and chat summarization when Alpha is idle; post-processing validates that the referenced user/assistant messages belong to the same chat.
- Added Beta13 runtime patching and regression coverage so both fresh source and the patched macOS preview receive the same behavior.

## 1.1.0-beta.12 — 2026-08-24

- Fixed a deterministic-routing gap where prompts such as `เช็คการเข้าถึง path /Volumes/...` could fall through to the LLM and falsely claim that Sandbox/Docker prevented host access.
- Extended `host_fs` with `action=access` to check real macOS process read/write/traverse capability and whether a missing destination is creatable from its nearest existing parent.
- Broadened direct host-path intent detection for Thai/English access, read, write, permission, exists, create, stat, and list wording when `/Volumes/...` or `/Users/...` is present.
- Host path access/verification now bypasses normal LLM/tool planning and returns deterministic macOS facts with `host_scope=macos` and `docker_used=false`.
- Added explicit model/tool instructions that `host_fs` facts outrank Sandbox inference and that Alpha must not send the user to Terminal for path/access checks it can perform itself.
- Added regression coverage for the exact macOS preview failure. See #12.

## 1.1.0-beta.11 — 2026-08-24

- Aligned the existing `full_user_files` setting with persistent Full local authority: Alpha no longer asks for a new confirmation every time it needs `run_host_artifact` or Homebrew package installation.
- `run_host_artifact`, `install_package`, and `install_packages` now execute immediately when Full mode is active; non-Full modes keep the existing approval queue.
- Host-tool results identify `permission_mode=persistent_full` and `approval_skipped=true` when a repeated approval was intentionally bypassed.
- Full mode still does not bypass protected paths, `.git`, `.env*`, `.dev.vars`, macOS system roots, symlink checks, artifact validation, package/formula validation, or authorized security-target scope.
- Settings UI now labels the Full option explicitly as `Full — ไฟล์ผู้ใช้ทั้งหมด + Host actions อัตโนมัติ` so the permission behavior matches what the user selected.
- Added regression coverage for Full-mode host execution and package setup. See #11.

## 1.1.0-beta.10 — 2026-08-24

- Decoupled SearXNG lifetime from the generic heavy-tool idle timeout: while Alpha is open, the local search service stays warm instead of being shut down after a few idle minutes.
- Added eager SearXNG startup and a lightweight 30-second keepalive that restores the Alpha-owned search container if it exits while the Tool Service is still running; explicit Alpha shutdown and storage-disconnect cleanup still stop it cleanly.
- Added `run_host_artifact`, an explicit approval-gated macOS-host execution path for canonical `.sh`, `.py`, `.js`, and `.mjs` artifacts when a task genuinely needs real Mac hardware, local network interfaces, local services, filesystem/runtime state, or installed CLI tools.
- Kept `run_artifact`/Skill Lab as Docker isolation for normal untrusted code tests instead of treating Sandbox as Alpha's universal operating environment.
- Host execution accepts a validated artifact path plus an argument array rather than an arbitrary shell command string, is restricted to the Alpha workspace, protects `.git`, `.env*`, and `.dev.vars`, and returns `execution_scope=macos_host` / `docker_used=false` with real stdout, stderr, and exit code.
- Model-facing routing now distinguishes capability domains: file operations and host inspection stay host-native; package installation uses the approval-gated Homebrew tools; isolated code tests use Docker; real user-authorized local operations can use macOS-host execution after explicit approval.

## 1.1.0-beta.9 — 2026-08-24

- Chat composer now grows automatically with multi-line/pasted text from a one-line minimum up to a viewport-aware cap (`min(35vh, 320px)`).
- Long prompts scroll inside the composer only after reaching the cap, and the composer shrinks back after the draft is cleared or sent.
- Enter-to-send and Shift+Enter newline behavior are unchanged.

## 1.1.0-beta.8 — 2026-08-24

- Separated Docker execution isolation from macOS host filesystem authority: `code_execution_mode=docker` applies only to `run_artifact` / Skill Lab execution, not ordinary file creation or inspection.
- Alpha's active `appDir` is now treated as a first-class host workspace for `create_files`, `manage_file`, and host filesystem operations, while sensitive workspace metadata such as `.dev.vars`, `.env*`, and `.git` remains protected.
- Successful file creation now reports `host_scope=macos`, `file_scope=macos_host`, `execution_scope=none`, `docker_used=false`, and the canonical workspace root.
- Model-facing instructions explicitly forbid claiming that a normal host file is inside Docker merely because code execution uses a sandbox.

## 1.1.0-beta.7 — 2026-08-24

- Added structured `FILE_DESTINATION_OUT_OF_SCOPE` results for rejected file destinations instead of forcing the model to infer recovery from error prose.
- File/program workflows automatically retry `create_files` in the safe Alpha Outputs location when the requested custom destination is not required exactly and is outside the current file scope.
- Exact-destination requests remain explicit instead of silently pretending the file was created somewhere else.
- Normal file-create recovery is host-native and returns `docker_used=false`; the model is instructed not to invent Docker/container/external-drive explanations for a plain file-policy error.

## 1.1.0-beta.6 — 2026-08-23

- Added a deterministic read-only `host_fs` tool for macOS host filesystem inspection (`exists`, `stat`, `list`).
- File/path verification no longer depends on the model choosing a tool correctly; questions such as “เช็คไฟล์”, “มีจริงไหม”, “หาไฟล์ไม่เจอ”, and “เช็ค path” are intercepted before the planner and checked on the macOS host directly.
- `host_fs` never launches Docker, Skill Lab, learned skills, or `run_artifact`; regression tests enforce this contract.
- Host filesystem results explicitly identify `host_scope=macos` and `docker_used=false` so Alpha cannot invent a Docker path or claim a sandbox check occurred.
- Paths inside Alpha's own `appDir` and output directory are always eligible for read-only metadata inspection; wider access continues to follow the configured file-access scope.
- If a prior assistant response claimed an absolute `/Volumes/...` or `/Users/...` path without a valid Artifact record, Alpha can verify that claimed path on the host instead of guessing that the external drive was disconnected.
- Host health now exposes `host_filesystem_ready` and the actual `app_dir`, and the preview launcher waits for host filesystem readiness before opening the UI.

## 1.1.0-beta.5 — 2026-08-23

- Added adaptive reasoning for the local `qwen3.5:9b` runtime instead of running every inference with thinking disabled.
- Tool planning now always uses thinking mode with a deep profile and at least a 16K context target, capped conservatively at 24K for the current Mac-first preview.
- Complex coding, debugging, architecture, security, research, and multi-step workflow requests automatically enable thinking and a larger context/output budget.
- Skill design, hidden-test generation, skill building/repair, and research synthesis now run as deep reasoning workers instead of `think: false` utility calls.
- Trivial local conversation intentionally stays on the fast non-thinking path so greetings and ordinary short questions do not inherit agent latency.
- Search classification, memory extraction, and lightweight summarization remain non-thinking utility work because deeper reasoning there adds latency without useful quality.
- Added a beta5 regression contract and CI build verification for the generated adaptive-reasoning runtime.

## 1.1.0-beta.4 — 2026-08-23

- Added a fast local-chat route so ordinary questions skip web classification, memory retrieval, learned-skill inventory, and tool planning before the single local model call.
- Added persistent agent-run states (`running`, `waiting_approval`, `completed`, `failed`, `blocked`) and a chat status card that polls the current task instead of leaving the user guessing whether background work is still running.
- Added batch Homebrew dependency installation so Alpha can request one approval for multiple missing formulas and resume the original workflow after installation.
- Hardened long-running workflows: file/program creation requests must continue until a real `create_files` Artifact exists, an approval is required, or a real blocker/failure is reached.
- Added truthful completion semantics: Alpha must not mark file-creation work completed when no Artifact was returned.
- Added Artifact-path grounding to chat history and direct file-location answers; Alpha reports the real path returned by Tool Service instead of guessing from the working directory.
- Added `.sh` Artifact support and zsh syntax validation in Tool Service so shell programs can actually be created as files.
- Disabled the canned Wi-Fi capability response that assumed external adapters/Linux before inspecting the current Mac.
- Kept Mac-first capability inspection and automatic package setup as the default path for authorized local lab work.

## 1.1.0-beta.3 — 2026-08-23

- Persisted host-tool approval requests to `work/host-tool-confirmations.json` with a 24-hour lifetime instead of keeping them only in process memory.
- Added idempotent completed approval results so duplicate clicks do not repeat successful package installs.
- Added restart recovery for interrupted approval state.
- Added live approval/action status polling in chat while an approved host action is running.
- Restored pending approval cards from saved chat tool events after page reload.
- Added automatic continuation of the original chat task after a successful package install; the user no longer needs to type “ทำต่อ”.
- Increased confirmation/install request timeout for long Homebrew installs.
- Reduced successful Homebrew installation output to a concise status while saving detailed install output under `work/host-install-logs/`.
- Kept the Mac-first capability policy: inspect and use built-in Mac hardware before claiming an external adapter is required.
- Added focused beta3 regression tests and a workflow that syntax-checks the runtime and commits the generated UI patch only after tests pass.

## 1.1.0-beta.2 — 2026-08-23

- Added Mac host capability inventory and a controlled Homebrew package-install workflow for the security-agent preview.
- Added the Mac Wireless Audit Controller preview skill and Mac-first hardware policy.
- Added `start-alpha-v11.command` for the preview Host Tool Controller.

## 1.0.0 — 2026-08-23

- Recovered all six findings from the recalled Auto Learn run as executable, installed skills.
- Added 4 visible and 20 hidden fixtures per recovered skill; all six pass 100% in their declared scope.
- Added deterministic chat routing for supported learned-skill inputs so simple requests bypass model planning.
- Preserved hidden-test evidence when live usage updates generalization confidence.
- Added repeatable recovery and runtime verification scripts under `scripts/`.
- Local Thai chat with persistent cross-chat memory and configurable personality.
- Deterministic web, browser, file and learned-skill routing.
- Auto Learn and Skill Lab with Docker verification, checkpoints and Skill-first backlog.
- Recall flow with owned-resource cleanup, atomic skill installation and downloadable reports.
- Fixed workspace UI, Skills registry and version/health visibility.
