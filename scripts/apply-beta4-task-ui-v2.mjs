import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] || process.cwd());
const path = resolve(appDir, "app", "page.tsx");
let source = await fs.readFile(path, "utf8");
const marker = "alpha-beta4-task-ui-v1";

if (source.includes(marker)) {
  console.log("Alpha beta4 task UI already applied");
  process.exit(0);
}

function replaceOnce(needle, replacement, label) {
  if (!source.includes(needle)) throw new Error(`หา ${label} ไม่พบ`);
  source = source.replace(needle, replacement);
}

const usageOld = [
  "interface Usage {",
  "  prompt_tokens: number;",
  "  response_tokens: number;",
  "  total_tokens: number;",
  "  context_limit: number;",
  "  unlimited_messages: boolean;",
  "}",
].join("\n");
const usageNew = usageOld + "\n\n" + [
  "// " + marker,
  "interface AgentRunView {",
  '  id: string;',
  '  status: "queued" | "running" | "waiting_approval" | "completed" | "failed" | "blocked";',
  "  stage: string;",
  "  label: string;",
  "  detail: string;",
  "  tool: string;",
  "  updated_at: number;",
  "}",
].join("\n");
replaceOnce(usageOld, usageNew, "Usage interface");

replaceOnce(
  '  const [thinkingSteps, setThinkingSteps] = useState<string[]>([]);\n  const [isThinking, setIsThinking] = useState(false);',
  '  const [thinkingSteps, setThinkingSteps] = useState<string[]>([]);\n'
    + '  const [isThinking, setIsThinking] = useState(false);\n'
    + '  const [activeRunId, setActiveRunId] = useState<string | null>(null);\n'
    + '  const [activeRun, setActiveRun] = useState<AgentRunView | null>(null);',
  "thinking state",
);

const effect = [
  "  useEffect(() => {",
  "    if (!activeRunId) return;",
  "    let stopped = false;",
  "    let clearTimer: number | undefined;",
  "    const poll = async () => {",
  "      try {",
  '        const response = await fetch("/api/tasks/" + encodeURIComponent(activeRunId), { cache: "no-store" });',
  "        if (!response.ok || stopped) return;",
  "        const data = await response.json() as { run?: AgentRunView };",
  "        if (data.run) {",
  "          setActiveRun(data.run);",
  '          if (["completed", "failed", "blocked"].includes(data.run.status) && clearTimer === undefined) {',
  "            clearTimer = window.setTimeout(() => {",
  "              if (!stopped) {",
  "                setActiveRunId(null);",
  "                setActiveRun(null);",
  "              }",
  "            }, 3500);",
  "          }",
  "        }",
  "      } catch { /* next poll retries */ }",
  "    };",
  "    void poll();",
  "    const timer = window.setInterval(() => void poll(), 800);",
  "    return () => {",
  "      stopped = true;",
  "      window.clearInterval(timer);",
  "      if (clearTimer !== undefined) window.clearTimeout(clearTimer);",
  "    };",
  "  }, [activeRunId]);",
  "",
].join("\n");
replaceOnce(
  "  async function runChat(content: string, forceSearch = false, addUser = true, removeMessageId?: string, existingUserId?: string) {",
  effect + "  async function runChat(content: string, forceSearch = false, addUser = true, removeMessageId?: string, existingUserId?: string) {",
  "runChat insertion",
);

replaceOnce(
  '    const userMessage: UiMessage = { id: existingUserId || crypto.randomUUID(), role: "user", content: cleanContent };\n'
    + "    const assistantId = crypto.randomUUID();",
  '    const userMessage: UiMessage = { id: existingUserId || crypto.randomUUID(), role: "user", content: cleanContent };\n'
    + "    const assistantId = crypto.randomUUID();\n"
    + "    setActiveRunId(userMessage.id);\n"
    + '    setActiveRun({ id: userMessage.id, status: "running", stage: "received", label: "รับคำขอแล้ว", detail: "", tool: "", updated_at: Date.now() });',
  "run id start",
);

const statusCard = [
  "            {activeRun && (",
  '              <div className={"thinking-bar task-state task-" + activeRun.status} role="status" aria-live="polite">',
  '                <div className="thinking-pulse"><span /><span /><span /></div>',
  "                <div>",
  '                  <strong>{activeRun.status === "completed" ? "✅ งานเสร็จแล้ว" : activeRun.status === "waiting_approval" ? "⏸ รอการอนุญาต" : activeRun.status === "failed" ? "❌ งานล้มเหลว" : activeRun.status === "blocked" ? "⛔ งานถูกบล็อก" : "🟢 อัลฟ่ากำลังทำงาน"}</strong>',
  '                  <span>{activeRun.label}{activeRun.detail ? " — " + activeRun.detail : ""}</span>',
  "                  {activeRun.tool && <small>Tool: {activeRun.tool}</small>}",
  "                </div>",
  '                <div className="thinking-track"><i /></div>',
  "              </div>",
  "            )}",
  "",
  "            {isThinking && !activeRun && (",
  '              <div className="thinking-bar" role="status" aria-live="polite">',
].join("\n");

replaceOnce(
  '            {isThinking && (\n              <div className="thinking-bar" role="status" aria-live="polite">',
  statusCard,
  "task status card",
);

const tmp = path + ".beta4-task-ui-v2.tmp";
await fs.writeFile(tmp, source, "utf8");
await fs.rename(tmp, path);
console.log("Applied beta4 persistent task UI v2");
