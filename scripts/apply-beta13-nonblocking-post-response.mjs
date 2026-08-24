import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] || process.cwd());
const marker = "alpha-beta13-nonblocking-post-response-v1";

async function patchChatRoute() {
  const path = resolve(appDir, "app", "api", "chat", "route.ts");
  let source = await fs.readFile(path, "utf8");
  if (source.includes(marker)) return;

  const startNeedle = '        if (!fastPath && settings.memory_enabled && settings.auto_learn_enabled && assistantText.trim()) {';
  const doneNeedle = '        controller.enqueue(event("done"));';
  const start = source.indexOf(startNeedle);
  const done = source.indexOf(doneNeedle, start);
  if (start < 0 || done < 0) throw new Error("หา post-response blocking block ไม่พบ");

  const replacement = [
    `        // ${marker}`,
    "        const postprocess = savedUser && savedAssistant ? {",
    "          chat_id: chat.id,",
    "          user_message_id: savedUser.id,",
    "          assistant_message_id: savedAssistant.id,",
    "        } : undefined;",
    '        controller.enqueue(event("done", postprocess ? { postprocess } : {}));',
  ].join("\n");

  source = source.slice(0, start) + replacement + source.slice(done + doneNeedle.length);
  const temp = `${path}.beta13.tmp`;
  await fs.writeFile(temp, source, "utf8");
  await fs.rename(temp, path);
}

async function patchChatUi() {
  const path = resolve(appDir, "app", "page.tsx");
  let source = await fs.readFile(path, "utf8");
  if (source.includes(marker)) return;

  function replaceOnce(needle, replacement, label) {
    if (!source.includes(needle)) throw new Error(`หา ${label} ไม่พบ`);
    source = source.replace(needle, replacement);
  }

  const refNeedle = "  const skillListRef = useRef<HTMLDivElement>(null);";
  const refReplacement = [
    refNeedle,
    `  // ${marker}`,
    "  const postprocessTimerRef = useRef<number | null>(null);",
    "  const postprocessAbortRef = useRef<AbortController | null>(null);",
    "",
    "  useEffect(() => () => {",
    "    if (postprocessTimerRef.current !== null) window.clearTimeout(postprocessTimerRef.current);",
    "    postprocessAbortRef.current?.abort();",
    "  }, []);",
  ].join("\n");
  replaceOnce(refNeedle, refReplacement, "postprocess refs");

  const runNeedle = "  async function runChat(content: string, forceSearch = false, addUser = true, removeMessageId?: string, existingUserId?: string) {";
  const helpers = [
    "  function cancelPendingChatPostprocess() {",
    "    if (postprocessTimerRef.current !== null) {",
    "      window.clearTimeout(postprocessTimerRef.current);",
    "      postprocessTimerRef.current = null;",
    "    }",
    "    postprocessAbortRef.current?.abort();",
    "    postprocessAbortRef.current = null;",
    "  }",
    "",
    "  function scheduleChatPostprocess(task: { chat_id: string; user_message_id: string; assistant_message_id: string }) {",
    "    cancelPendingChatPostprocess();",
    "    postprocessTimerRef.current = window.setTimeout(async () => {",
    "      postprocessTimerRef.current = null;",
    "      const controller = new AbortController();",
    "      postprocessAbortRef.current = controller;",
    "      try {",
    '        const response = await fetch(`/api/chats/${encodeURIComponent(task.chat_id)}/postprocess`, {',
    '          method: "POST",',
    '          headers: { "Content-Type": "application/json" },',
    "          body: JSON.stringify({ user_message_id: task.user_message_id, assistant_message_id: task.assistant_message_id }),",
    "          signal: controller.signal,",
    "        });",
    "        if (!response.ok) return;",
    "        const result = await response.json() as { memories_added?: number; summarized?: boolean };",
    "        if ((result.memories_added ?? 0) > 0) void loadMemories();",
    "        if (result.summarized) void loadChats(chatSearch);",
    "      } catch (error) {",
    '        if (!(error instanceof DOMException && error.name === "AbortError")) console.warn("Alpha chat post-processing failed", error);',
    "      } finally {",
    "        if (postprocessAbortRef.current === controller) postprocessAbortRef.current = null;",
    "      }",
    "    }, 8_000);",
    "  }",
    "",
    runNeedle,
  ].join("\n");
  replaceOnce(runNeedle, helpers, "runChat");

  replaceOnce(
    "    if (!cleanContent || isThinking) return;",
    "    if (!cleanContent || isThinking) return;\n    cancelPendingChatPostprocess();",
    "postprocess cancellation",
  );
  replaceOnce(
    '    setThinkingSteps(["รับคำถามแล้ว", "กำลังตรวจสอบกฎ"]);',
    '    setThinkingSteps(["รับคำถามแล้ว", "กำลังตรวจสอบกฎ"]);\n    let pendingPostprocess: { chat_id: string; user_message_id: string; assistant_message_id: string } | null = null;',
    "postprocess task state",
  );

  const savedNeedle = [
    '          if (event.type === "message_saved" && event.message && typeof event.message === "object") {',
    '            const saved = event.message as { id?: string; role?: string };',
    '            if (saved.role === "assistant" && saved.id) {',
    '              setMessages((current) => current.map((message) => message.id === assistantId ? { ...message, id: saved.id! } : message));',
    "            }",
    "          }",
  ].join("\n");
  const savedReplacement = savedNeedle + "\n" + [
    '          if (event.type === "done" && event.postprocess && typeof event.postprocess === "object") {',
    "            const task = event.postprocess as Record<string, unknown>;",
    '            if (typeof task.chat_id === "string" && typeof task.user_message_id === "string" && typeof task.assistant_message_id === "string") {',
    "              pendingPostprocess = task as { chat_id: string; user_message_id: string; assistant_message_id: string };",
    "            }",
    "          }",
  ].join("\n");
  replaceOnce(savedNeedle, savedReplacement, "done postprocess event");

  const runStart = source.indexOf(runNeedle);
  const catchNeedle = "      }\n    } catch (error) {";
  const catchIndex = source.indexOf(catchNeedle, runStart);
  if (runStart < 0 || catchIndex < 0) throw new Error("หาจุดจบ chat stream ไม่พบ");
  source = source.slice(0, catchIndex) + "      }\n      if (pendingPostprocess) scheduleChatPostprocess(pendingPostprocess);\n" + source.slice(catchIndex + "      }\n".length);

  const temp = `${path}.beta13.tmp`;
  await fs.writeFile(temp, source, "utf8");
  await fs.rename(temp, path);
}

await patchChatRoute();
await patchChatUi();
console.log("Applied Alpha beta13 non-blocking chat post-processing");
