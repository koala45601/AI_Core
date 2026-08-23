import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] || process.cwd());
const path = resolve(appDir, "app", "page.tsx");
let source = await fs.readFile(path, "utf8");
const marker = "alpha-beta4-task-ui-v1";
if (source.includes(marker)) process.exit(0);

function replaceOnce(needle, replacement, label) {
  if (!source.includes(needle)) throw new Error(`หา ${label} ไม่พบ`);
  source = source.replace(needle, replacement);
}

replaceOnce(
  `interface Usage {\n  prompt_tokens: number;\n  response_tokens: number;\n  total_tokens: number;\n  context_limit: number;\n  unlimited_messages: boolean;\n}`,
  `interface Usage {\n  prompt_tokens: number;\n  response_tokens: number;\n  total_tokens: number;\n  context_limit: number;\n  unlimited_messages: boolean;\n}\n\n// ${marker}\ninterface AgentRunView {\n  id: string;\n  status: "queued" | "running" | "waiting_approval" | "completed" | "failed" | "blocked";\n  stage: string;\n  label: string;\n  detail: string;\n  tool: string;\n  updated_at: number;\n}`,
  "Usage interface",
);

replaceOnce(
  `  const [thinkingSteps, setThinkingSteps] = useState<string[]>([]);\n  const [isThinking, setIsThinking] = useState(false);`,
  `  const [thinkingSteps, setThinkingSteps] = useState<string[]>([]);\n  const [isThinking, setIsThinking] = useState(false);\n  const [activeRunId, setActiveRunId] = useState<string | null>(null);\n  const [activeRun, setActiveRun] = useState<AgentRunView | null>(null);`,
  "thinking state",
);

replaceOnce(
  `  async function runChat(content: string, forceSearch = false, addUser = true, removeMessageId?: string, existingUserId?: string) {`,
  `  useEffect(() => {\n    if (!activeRunId) return;\n    let stopped = false;\n    const poll = async () => {\n      try {\n        const response = await fetch(\`/api/tasks/\${encodeURIComponent(activeRunId)}\`, { cache: "no-store" });\n        if (!response.ok || stopped) return;\n        const data = await response.json() as { run?: AgentRunView };\n        if (data.run) {\n          setActiveRun(data.run);\n          if (["completed", "failed", "blocked"].includes(data.run.status)) {\n            window.setTimeout(() => { if (!stopped) setActiveRunId(null); }, 3500);\n          }\n        }\n      } catch { /* next poll retries */ }\n    };\n    void poll();\n    const timer = window.setInterval(() => void poll(), 800);\n    return () => { stopped = true; window.clearInterval(timer); };\n  }, [activeRunId]);\n\n  async function runChat(content: string, forceSearch = false, addUser = true, removeMessageId?: string, existingUserId?: string) {`,
  "runChat insertion",
);

replaceOnce(
  `    const userMessage: UiMessage = { id: existingUserId || crypto.randomUUID(), role: "user", content: cleanContent };\n    const assistantId = crypto.randomUUID();`,
  `    const userMessage: UiMessage = { id: existingUserId || crypto.randomUUID(), role: "user", content: cleanContent };\n    const assistantId = crypto.randomUUID();\n    setActiveRunId(userMessage.id);\n    setActiveRun({ id: userMessage.id, status: "running", stage: "received", label: "รับคำขอแล้ว", detail: "", tool: "", updated_at: Date.now() });`,
  "run id start",
);

replaceOnce(
  `            {isThinking && (\n              <div className="thinking-bar" role="status" aria-live="polite">`,
  `            {activeRun && (\n              <div className={\`thinking-bar task-state task-\${activeRun.status}\`} role="status" aria-live="polite">\n                <div className="thinking-pulse"><span /><span /><span /></div>\n                <div>\n                  <strong>{activeRun.status === "completed" ? "✅ งานเสร็จแล้ว" : activeRun.status === "waiting_approval" ? "⏸ รอการอนุญาต" : activeRun.status === "failed" ? "❌ งานล้มเหลว" : activeRun.status === "blocked" ? "⛔ งานถูกบล็อก" : "🟢 อัลฟ่ากำลังทำงาน"}</strong>\n                  <span>{activeRun.label}{activeRun.detail ? ` — ${activeRun.detail}` : ""}</span>\n                  {activeRun.tool && <small>Tool: {activeRun.tool}</small>}\n                </div>\n                <div className="thinking-track"><i /></div>\n              </div>\n            )}\n\n            {isThinking && !activeRun && (\n              <div className="thinking-bar" role="status" aria-live="polite">`,
  "task status card",
);

const tmp = `${path}.beta4.tmp`;
await fs.writeFile(tmp, source, "utf8");
await fs.rename(tmp, path);
console.log("Applied beta4 task UI");
