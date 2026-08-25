import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] || process.cwd());
const marker = "alpha-beta23-create-video-phase1-v1";

function replaceOnce(source, needle, replacement, label) {
  if (!source.includes(needle)) throw new Error(`หา ${label} ไม่พบ — หยุดแทนการ patch ผิดตำแหน่ง`);
  return source.replace(needle, replacement);
}

async function writeAtomic(path, content) {
  const temp = `${path}.beta23.tmp`;
  await fs.writeFile(temp, content, "utf8");
  await fs.rename(temp, path);
}

async function patchPage() {
  const path = resolve(appDir, "app", "page.tsx");
  let source = await fs.readFile(path, "utf8");
  if (source.includes(marker)) return;
  source = replaceOnce(
    source,
    'import { ALPHA_DISPLAY_VERSION } from "@/lib/version";',
    'import { ALPHA_DISPLAY_VERSION } from "@/lib/version";\nimport CreateVideoStudio from "@/components/create-video-studio"; // ' + marker,
    "Create Video component import",
  );
  source = replaceOnce(
    source,
    'type View = "chat" | "memory" | "skills" | "tickets" | "settings";',
    'type View = "chat" | "video" | "memory" | "skills" | "tickets" | "settings";',
    "View union",
  );
  source = replaceOnce(
    source,
    '          <button className={`nav-item ${view === "chat" ? "active" : ""}`} type="button" onClick={() => setView("chat")}><span>⌁</span>สนทนา</button>',
    '          <button className={`nav-item ${view === "chat" ? "active" : ""}`} type="button" onClick={() => setView("chat")}><span>⌁</span>สนทนา</button>\n          <button className={`nav-item ${view === "video" ? "active" : ""}`} type="button" onClick={() => setView("video")}><span>▶</span>Create Video</button>',
    "sidebar video navigation",
  );
  source = replaceOnce(
    source,
    '<span className="eyebrow">{view === "chat" ? "LOCAL AI CHAT" : view === "memory" ? "LEARNING WORKSPACE" : view === "skills" ? "SKILL REGISTRY" : view === "tickets" ? "TICKET BOT STUDIO" : "CONTROL CENTER"}</span>',
    '<span className="eyebrow">{view === "chat" ? "LOCAL AI CHAT" : view === "video" ? "LOCAL AI FILM STUDIO" : view === "memory" ? "LEARNING WORKSPACE" : view === "skills" ? "SKILL REGISTRY" : view === "tickets" ? "TICKET BOT STUDIO" : "CONTROL CENTER"}</span>',
    "topbar eyebrow",
  );
  source = replaceOnce(
    source,
    '<h1>{view === "chat" ? activeChat?.title || "คุยกับอัลฟ่า" : view === "memory" ? "สอนและพัฒนาอัลฟ่า" : view === "skills" ? "ทักษะของอัลฟ่า" : view === "tickets" ? "สร้างบอทบัตรแบบ Full Loop" : "ตั้งค่าอัลฟ่า"}</h1>',
    '<h1>{view === "chat" ? activeChat?.title || "คุยกับอัลฟ่า" : view === "video" ? "Create Video" : view === "memory" ? "สอนและพัฒนาอัลฟ่า" : view === "skills" ? "ทักษะของอัลฟ่า" : view === "tickets" ? "สร้างบอทบัตรแบบ Full Loop" : "ตั้งค่าอัลฟ่า"}</h1>',
    "topbar title",
  );
  source = replaceOnce(
    source,
    '        {view === "memory" && (',
    '        {view === "video" && <CreateVideoStudio />}\n\n        {view === "memory" && (',
    "Create Video render slot",
  );
  await writeAtomic(path, source);
}

const cssBlock = `
/* ${marker} */
.create-video-view { height: calc(100dvh - 102px); min-height: 0; overflow-y: auto; padding: 24px clamp(24px, 4vw, 64px) 48px; display: grid; gap: 18px; }
.create-video-hero { display: flex; justify-content: space-between; gap: 24px; align-items: stretch; }
.create-video-hero > div:first-child { flex: 1; padding: 12px 0; }
.create-video-hero h2 { margin: 5px 0 8px; font: 500 clamp(27px, 3vw, 38px) Georgia, "Noto Serif Thai", serif; }
.create-video-hero p { max-width: 760px; margin: 0; color: var(--muted); line-height: 1.65; font-size: 13px; }
.create-video-resource-card { min-width: 320px; max-width: 420px; display: grid; gap: 5px; align-content: center; padding: 16px 18px; border: 1px solid #cfe0d7; border-radius: 16px; background: #f7fbf9; }
.create-video-resource-card strong { font-size: 12px; color: var(--green-dark); }
.create-video-resource-card span { font: 700 11px ui-monospace, SFMono-Regular, Menlo, monospace; color: #47705f; }
.create-video-resource-card small { color: var(--muted); font-size: 10px; }
.create-video-resource-card b { margin-top: 4px; color: #8a663d; font-size: 10px; }
.create-video-layout { min-height: 0; display: grid; grid-template-columns: 230px minmax(0, 1fr); gap: 16px; align-items: start; }
.video-project-list, .video-project-form, .video-registry-grid > article, .shot-plan-panel { border: 1px solid var(--line); border-radius: 16px; background: #fff; box-shadow: 0 9px 30px #214b3b08; }
.video-project-list { position: sticky; top: 0; overflow: hidden; }
.video-panel-head { min-height: 44px; padding: 0 14px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--line); }
.video-panel-head strong { font-size: 11px; }
.video-panel-head span { color: var(--muted); font-size: 9px; }
.video-project-scroll { max-height: 62vh; overflow-y: auto; padding: 8px; display: grid; gap: 6px; }
.video-project-scroll > button { width: 100%; padding: 10px; border: 1px solid transparent; border-radius: 10px; background: transparent; display: grid; gap: 3px; text-align: left; cursor: pointer; }
.video-project-scroll > button:hover { background: #f4f8f5; }
.video-project-scroll > button.active { border-color: #b8d6c8; background: #eaf3ee; }
.video-project-scroll strong { font-size: 10px; }.video-project-scroll span, .video-project-scroll small { color: var(--muted); font-size: 8px; }
.video-project-scroll p { padding: 20px 8px; color: var(--muted); font-size: 10px; text-align: center; }
.video-workspace { min-width: 0; display: grid; gap: 16px; }
.video-project-form { padding: 18px; display: grid; gap: 13px; }
.video-section-title { display: flex; justify-content: space-between; align-items: center; gap: 18px; }
.video-section-title h3 { margin: 3px 0 0; font: 500 20px Georgia, "Noto Serif Thai", serif; }
.video-section-title > span { color: var(--muted); font-size: 10px; }
.video-project-form label, .shot-card label { display: grid; gap: 5px; color: #52615a; font-size: 9px; font-weight: 700; }
.video-project-form input, .video-project-form textarea, .video-project-form select, .shot-card input, .shot-card textarea { width: 100%; border: 1px solid #d8e4dc; border-radius: 9px; background: #fbfdfc; padding: 9px 10px; color: var(--ink); font-size: 11px; }
.video-project-form textarea, .shot-card textarea { resize: vertical; line-height: 1.55; }
.video-grid { display: grid; gap: 10px; }.video-grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }.video-grid.four { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.video-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.video-actions button, .video-validation-row button, .shot-inline button { border: 1px solid #cddfd5; border-radius: 9px; padding: 8px 11px; background: #f2f7f4; color: var(--green-dark); cursor: pointer; font-size: 10px; font-weight: 700; }
.video-actions button.primary { background: var(--green-dark); color: white; border-color: var(--green-dark); }
.video-actions button:disabled, .shot-inline button:disabled { opacity: .48; cursor: not-allowed; }
.video-status { padding: 9px 11px; border-radius: 9px; background: #edf6f1; color: #376451; font-size: 10px; }.video-status.error { background: #faeeee; color: var(--danger); }
.video-registry-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.video-registry-grid > article { overflow: hidden; }
.registry-scroll { max-height: 260px; overflow-y: auto; padding: 10px; display: grid; gap: 7px; }
.registry-card { padding: 9px 10px; border: 1px solid #e0e9e4; border-radius: 10px; display: grid; gap: 3px; background: #fbfdfc; }
.registry-card b { color: var(--green); font: 700 8px ui-monospace, monospace; }.registry-card strong { font-size: 10px; }.registry-card small, .registry-card span { color: var(--muted); font-size: 8px; line-height: 1.4; }
.shot-plan-panel { padding: 18px; display: grid; gap: 12px; }
.video-story-summary { margin: 0; padding: 10px 12px; border-radius: 10px; background: #f4f8f5; color: #53625b; line-height: 1.6; font-size: 10px; }
.shot-card-list { display: grid; gap: 9px; }
.shot-card { padding: 13px; border: 1px solid #dce6e0; border-radius: 12px; background: #fcfefd; display: grid; gap: 9px; }
.shot-card header { display: flex; justify-content: space-between; align-items: center; gap: 12px; }.shot-card header > div { display: flex; gap: 8px; align-items: baseline; }
.shot-card header b { color: var(--green-dark); font: 800 10px ui-monospace, monospace; }.shot-card header span { color: var(--muted); font-size: 8px; }
.shot-meta { display: flex; flex-wrap: wrap; gap: 6px; }.shot-meta span { padding: 4px 7px; border-radius: 99px; background: #edf4f0; color: #587067; font-size: 8px; }
.shot-inline { display: grid; grid-template-columns: 120px auto; gap: 10px; align-items: end; }.shot-inline button { justify-self: start; }
.video-validation-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; color: var(--muted); font-size: 9px; }.video-validation-row .pass { color: #267654; font-weight: 700; }.video-validation-row .warn { color: #9b6736; font-weight: 700; }.video-validation-row button { margin-left: auto; }
@media (max-width: 1100px) { .create-video-hero { display: grid; }.create-video-resource-card { min-width: 0; max-width: none; }.video-grid.four { grid-template-columns: repeat(2, minmax(0, 1fr)); }.create-video-layout { grid-template-columns: 190px minmax(0, 1fr); } }
@media (max-width: 820px) { .create-video-layout { grid-template-columns: 1fr; }.video-project-list { position: static; }.video-project-scroll { max-height: 180px; }.video-grid.two, .video-grid.four, .video-registry-grid { grid-template-columns: 1fr; } }
`;

async function patchCss() {
  const path = resolve(appDir, "app", "globals.css");
  const source = await fs.readFile(path, "utf8");
  if (source.includes(marker)) return;
  await writeAtomic(path, `${source.trimEnd()}\n${cssBlock}\n`);
}

async function patchPackage() {
  const path = resolve(appDir, "package.json");
  const pkg = JSON.parse(await fs.readFile(path, "utf8"));
  pkg.version = "1.1.0-beta.23";
  await writeAtomic(path, `${JSON.stringify(pkg, null, 2)}\n`);
}

await patchPage();
await patchCss();
await patchPackage();
console.log("Applied Alpha beta23 Create Video Phase 1");
