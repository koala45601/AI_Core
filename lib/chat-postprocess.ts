import { estimateTokens, getChat, getMessage, listChatMessages, saveChatSummary } from "./chat-store";
import { addMemory } from "./memory-store";
import { extractDurableMemories, summarizeChat } from "./ollama";
import { redactCredentials } from "./context-routing.js";
import { AppSettings } from "./types";

export interface ChatPostprocessInput {
  chatId: string;
  userMessageId: string;
  assistantMessageId: string;
  settings: AppSettings;
  signal?: AbortSignal;
}

export interface ChatPostprocessResult {
  memories_added: number;
  summarized: boolean;
  skipped: boolean;
}

export async function postprocessChatTurn(input: ChatPostprocessInput): Promise<ChatPostprocessResult> {
  const { chatId, userMessageId, assistantMessageId, settings, signal } = input;
  const [chat, userMessage, assistantMessage] = await Promise.all([
    getChat(chatId),
    getMessage(userMessageId),
    getMessage(assistantMessageId),
  ]);

  if (!chat || !userMessage || !assistantMessage || userMessage.chat_id !== chatId || assistantMessage.chat_id !== chatId
    || userMessage.role !== "user" || assistantMessage.role !== "assistant") {
    throw new Error("ข้อมูลข้อความสำหรับประมวลผลเบื้องหลังไม่ตรงกับแชต");
  }

  let memoriesAdded = 0;
  if (settings.memory_enabled && settings.auto_learn_enabled && assistantMessage.content.trim()) {
    const extracted = await extractDurableMemories(
      redactCredentials(userMessage.content),
      redactCredentials(assistantMessage.content),
      settings,
      signal,
    );
    for (const item of extracted) {
      if (signal?.aborted) throw signal.reason;
      const memory = await addMemory(item.content, "auto", {
        category: item.category,
        confidence: item.confidence,
        sourceChatId: chatId,
      });
      if (memory) memoriesAdded += 1;
    }
  }

  let summarized = false;
  if (settings.auto_summarize_enabled) {
    const allMessages = await listChatMessages(chatId);
    const userTurns = allMessages.filter((item) => item.role === "user").length;
    const shouldSummarize = userTurns > 0
      && (userTurns % 6 === 0 || estimateTokens(allMessages) > 3500)
      && allMessages.length > chat.summarized_message_count;
    if (shouldSummarize) {
      const summary = await summarizeChat(
        allMessages.map(({ role, content }) => ({ role, content })),
        chat.rolling_summary,
        settings,
        signal,
      );
      if (signal?.aborted) throw signal.reason;
      await saveChatSummary(chatId, summary, allMessages.length);
      summarized = true;
    }
  }

  return {
    memories_added: memoriesAdded,
    summarized,
    skipped: memoriesAdded === 0 && !summarized,
  };
}
