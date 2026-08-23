# Alpha changelog

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
