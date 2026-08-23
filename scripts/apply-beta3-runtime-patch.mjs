import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] || process.cwd());
const pagePath = resolve(appDir, "app", "page.tsx");
let source = await fs.readFile(pagePath, "utf8");
const marker = "alpha-beta3-resume-v1";

if (source.includes(marker)) {
  console.log("Alpha beta3 UI resume patch already applied");
  process.exit(0);
}

const oldLoadChat = `      const data = await response.json() as {
        messages: Array<{ id: string; role: "user" | "assistant"; content: string; metadata?: { sources?: SearchResult[]; artifacts?: ArtifactRecord[]; error?: boolean } }>;
      };
      setMessages(data.messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        sources: message.metadata?.sources,
        artifacts: message.metadata?.artifacts,
        error: message.metadata?.error,
      })));`;

const newLoadChat = `      const data = await response.json() as {
        messages: Array<{ id: string; role: "user" | "assistant"; content: string; metadata?: { sources?: SearchResult[]; artifacts?: ArtifactRecord[]; error?: boolean; tool_events?: Array<Record<string, unknown>> } }>;
      };
      setMessages(data.messages.map((message) => {
        const permissionEvent = [...(message.metadata?.tool_events ?? [])].reverse().find((item) =>
          item.type === "permission_required" && typeof item.confirmation_id === "string"
        );
        return {
          id: message.id,
          role: message.role,
          content: message.content,
          sources: message.metadata?.sources,
          artifacts: message.metadata?.artifacts,
          error: message.metadata?.error,
          permission: permissionEvent ? {
            confirmationId: String(permissionEvent.confirmation_id),
            summary: String(permissionEvent.summary || "อนุญาตให้ใช้เครื่องมือนี้หรือไม่?"),
            tool: String(permissionEvent.tool || "tool"),
          } : undefined,
        };
      }));`;

if (!source.includes(oldLoadChat)) {
  throw new Error("หา loadChat block สำหรับ beta3 ไม่พบ — หยุดแทนการ patch ผิดตำแหน่ง");
}
source = source.replace(oldLoadChat, newLoadChat);

const functionStart = source.indexOf("  async function confirmPermission(");
const functionEnd = source.indexOf("\n  async function openArtifact", functionStart);
if (functionStart < 0 || functionEnd < 0) {
  throw new Error("หา confirmPermission block สำหรับ beta3 ไม่พบ — หยุดแทนการ patch ผิดตำแหน่ง");
}

const newConfirmPermission = `  // ${marker}
  async function confirmPermission(messageId: string, confirmationId: string, approved: boolean) {
    const permissionIndex = messages.findIndex((item) => item.id === messageId);
    const previousUser = permissionIndex > 0
      ? [...messages.slice(0, permissionIndex)].reverse().find((item) => item.role === "user")
      : undefined;
    let statusTimer: number | undefined;
    let resumed = false;

    if (approved) {
      setIsThinking(true);
      setThinkingSteps(["ได้รับอนุญาตแล้ว", "กำลังดำเนินการที่ได้รับอนุญาต"]);
      statusTimer = window.setInterval(async () => {
        try {
          const statusResponse = await fetch(\`/api/tools/status?id=\${encodeURIComponent(confirmationId)}\`, { cache: "no-store" });
          if (!statusResponse.ok) return;
          const status = await statusResponse.json() as { status?: string };
          const label = status.status === "running"
            ? "กำลังติดตั้ง/ดำเนินการบน Mac"
            : status.status === "completed"
              ? "ขั้นที่อนุญาตเสร็จแล้ว กำลังเตรียมทำงานเดิมต่อ"
              : status.status === "pending"
                ? "คำขออนุญาตถูกเก็บไว้แล้ว กำลังเริ่มทำงาน"
                : "กำลังตรวจผลของขั้นที่ได้รับอนุญาต";
          setThinkingSteps((steps) => [...steps.filter((item) => item !== label), label].slice(-5));
        } catch { /* ตัว POST หลักยังเป็นแหล่งผลลัพธ์หลัก */ }
      }, 1_000);
    }

    try {
      const response = await fetch("/api/tools/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation_id: confirmationId, approved, message_id: messageId }),
      });
      const result = await response.json() as {
        ok?: boolean;
        error?: string;
        message?: string;
        artifacts?: ArtifactRecord[];
        stdout?: string;
        stderr?: string;
        denied?: boolean;
        expired?: boolean;
        retryable?: boolean;
        resume?: boolean;
        resume_prompt?: string;
        package?: string;
        version?: string;
      };
      if (!response.ok) throw new Error(result.error || "ยืนยันไม่สำเร็จ");

      const conciseStatus = result.denied
        ? "ไม่ได้ดำเนินการ เพราะคุณไม่อนุญาต"
        : String(result.message || (result.ok === false ? result.error || "ดำเนินการไม่สำเร็จ" : "ขั้นที่ได้รับอนุญาตเสร็จแล้ว"));
      setMessages((current) => current.map((message) => message.id === messageId
        ? {
          ...message,
          permission: undefined,
          error: result.ok === false && !result.denied,
          artifacts: result.artifacts ? [...(message.artifacts ?? []), ...result.artifacts] : message.artifacts,
          content: conciseStatus,
        }
        : message));
      void loadHealth();

      if (approved && result.resume === true && previousUser && !result.denied && result.ok !== false) {
        const resumePrompt = [
          String(result.resume_prompt || "ขั้นที่ต้องขออนุญาตเสร็จแล้ว ให้ดำเนินงานเดิมต่อจากจุดที่ค้าง"),
          \`คำขอเดิมของผู้ใช้: \${previousUser.content}\`,
          \`ผลขั้นล่าสุด: \${conciseStatus}\`,
          "ตรวจสถานะ/capability ใหม่ก่อน แล้วทำขั้นถัดไปอัตโนมัติ ถ้ายังขาด dependency อื่นให้ใช้ tool ที่เหมาะสมต่อ ห้ามหยุดเพียงเพราะขั้นติดตั้งเสร็จ",
        ].join("\\n\\n");
        resumed = true;
        setIsThinking(false);
        setThinkingSteps([]);
        window.setTimeout(() => {
          void runChat(resumePrompt, false, false, messageId, previousUser.id);
        }, 0);
        return;
      }
    } catch (error) {
      setMessages((current) => current.map((message) => message.id === messageId
        ? { ...message, permission: undefined, content: \`\${message.content}\\n\\n\${error instanceof Error ? error.message : "ยืนยันไม่สำเร็จ"}\`, error: true }
        : message));
    } finally {
      if (statusTimer !== undefined) window.clearInterval(statusTimer);
      if (!resumed) {
        setIsThinking(false);
        setThinkingSteps([]);
      }
    }
  }
`;

source = `${source.slice(0, functionStart)}${newConfirmPermission}${source.slice(functionEnd)}`;

const temporary = `${pagePath}.beta3.tmp`;
await fs.writeFile(temporary, source, "utf8");
await fs.rename(temporary, pagePath);
console.log("Applied Alpha beta3 persistent-approval + auto-resume UI patch");
