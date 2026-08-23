import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] || process.cwd());
const marker = "alpha-beta9-auto-grow-composer-v1";

function replaceOnce(source, needle, replacement, label) {
  if (!source.includes(needle)) throw new Error(`หา ${label} ไม่พบ — หยุดแทนการ patch ผิดตำแหน่ง`);
  return source.replace(needle, replacement);
}

async function patchPage() {
  const path = resolve(appDir, "app", "page.tsx");
  let source = await fs.readFile(path, "utf8");
  if (source.includes(marker)) return;

  const refsNeedle = [
    "  const messageScrollRef = useRef<HTMLDivElement>(null);",
    "  const messageEndRef = useRef<HTMLDivElement>(null);",
    "  const followLatestRef = useRef(true);",
    "  const skillListRef = useRef<HTMLDivElement>(null);",
  ].join("\n");

  const refsReplacement = [
    `  // ${marker}`,
    "  const messageScrollRef = useRef<HTMLDivElement>(null);",
    "  const messageEndRef = useRef<HTMLDivElement>(null);",
    "  const composerInputRef = useRef<HTMLTextAreaElement>(null);",
    "  const followLatestRef = useRef(true);",
    "  const skillListRef = useRef<HTMLDivElement>(null);",
    "",
    "  useEffect(() => {",
    "    const textarea = composerInputRef.current;",
    "    if (!textarea) return;",
    "    textarea.style.height = \"auto\";",
    "    const viewportCap = typeof window === \"undefined\" ? 320 : Math.min(320, Math.max(140, Math.floor(window.innerHeight * 0.35)));",
    "    const nextHeight = Math.max(38, Math.min(textarea.scrollHeight, viewportCap));",
    "    textarea.style.height = `${nextHeight}px`;",
    "    textarea.style.overflowY = textarea.scrollHeight > viewportCap ? \"auto\" : \"hidden\";",
    "  }, [draft]);",
  ].join("\n");

  source = replaceOnce(source, refsNeedle, refsReplacement, "chat composer refs");

  const textareaNeedle = '<textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {';
  const textareaReplacement = '<textarea ref={composerInputRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {';
  source = replaceOnce(source, textareaNeedle, textareaReplacement, "main composer textarea");

  const temp = `${path}.beta9.tmp`;
  await fs.writeFile(temp, source, "utf8");
  await fs.rename(temp, path);
}

async function patchCss() {
  const path = resolve(appDir, "app", "globals.css");
  let source = await fs.readFile(path, "utf8");
  if (source.includes(marker)) return;

  const cssNeedle = ".composer textarea { width: 100%; min-height: 38px; max-height: 130px; resize: none; outline: none; border: 0; background: transparent; color: var(--ink); line-height: 1.5; }";
  const cssReplacement = `/* ${marker} */\n.composer textarea { width: 100%; min-height: 38px; max-height: min(35vh, 320px); resize: none; overflow-y: hidden; outline: none; border: 0; background: transparent; color: var(--ink); line-height: 1.5; transition: height .08s ease; }`;
  source = replaceOnce(source, cssNeedle, cssReplacement, "composer textarea css");

  const temp = `${path}.beta9.tmp`;
  await fs.writeFile(temp, source, "utf8");
  await fs.rename(temp, path);
}

await patchPage();
await patchCss();
console.log("Applied Alpha beta9 auto-growing composer: draft content expands to a viewport-aware cap and shrinks after send");
