# Alpha changelog

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
