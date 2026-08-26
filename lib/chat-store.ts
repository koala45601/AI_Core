import { env } from "cloudflare:workers";
import { ArtifactRecord, SearchResult } from "./types";

interface RuntimeEnv { DB?: D1Database }

export interface ChatRecord {
  id: string;
  title: string;
  rolling_summary: string;
  status: "active" | "archived";
  pinned: number;
  message_count: number;
  last_preview: string;
  summarized_message_count: number;
  created_at: number;
  updated_at: number;
}

export interface MessageMetadata {
  sources?: SearchResult[];
  artifacts?: ArtifactRecord[];
  searched?: boolean;
  search_backend?: string;
  tool_events?: Array<Record<string, unknown>>;
  learned_skill_id?: string;
  error?: boolean;
  inspected_url?: string;
  pending_ticket_events?: Array<Record<string, unknown>>;
  pending_ticket_build?: Record<string, unknown>;
  ticket_run?: Record<string, unknown>;
  ticket_workflow?: Record<string, unknown>;
}

export interface StoredChatMessage {
  id: string;
  chat_id: string;
  sequence: number;
  role: "user" | "assistant";
  content: string;
  metadata: MessageMetadata;
  prompt_tokens: number;
  response_tokens: number;
  created_at: number;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, rolling_summary TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active', pinned INTEGER NOT NULL DEFAULT 0,
    message_count INTEGER NOT NULL DEFAULT 0, last_preview TEXT NOT NULL DEFAULT '',
    summarized_message_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chats_updated_at ON chats(updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_chats_status_pinned ON chats(status, pinned DESC)`,
  `CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY NOT NULL, chat_id TEXT NOT NULL, sequence INTEGER NOT NULL,
    role TEXT NOT NULL, content TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}',
    prompt_tokens INTEGER NOT NULL DEFAULT 0, response_tokens INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_sequence ON chat_messages(chat_id, sequence)`,
  `CREATE TABLE IF NOT EXISTS message_feedback (
    id TEXT PRIMARY KEY NOT NULL, message_id TEXT NOT NULL, rating INTEGER NOT NULL,
    correction TEXT NOT NULL DEFAULT '', remember_correction INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    FOREIGN KEY(message_id) REFERENCES chat_messages(id) ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_message_feedback_message ON message_feedback(message_id)`,
];

function database(): D1Database | undefined {
  return (env as unknown as RuntimeEnv).DB;
}

async function ensureSchema(db: D1Database) {
  for (const statement of SCHEMA) await db.prepare(statement).run();
}

function cleanTitle(value: string): string {
  const cleaned = value.replace(/https?:\/\/\S+/gi, "เว็บไซต์").replace(/\s+/g, " ").trim();
  if (!cleaned) return "แชตใหม่";
  return cleaned.length > 56 ? `${cleaned.slice(0, 56)}…` : cleaned;
}

function parseMetadata(value: string): MessageMetadata {
  try { return JSON.parse(value) as MessageMetadata; } catch { return {}; }
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function grams(value: string): Set<string> {
  const compact = normalize(value).replace(/[^\p{L}\p{N}]+/gu, "");
  const result = new Set<string>();
  for (let index = 0; index <= compact.length - 3; index += 1) result.add(compact.slice(index, index + 3));
  return result;
}

export async function createChat(firstMessage = ""): Promise<ChatRecord> {
  const db = database();
  const now = Date.now();
  const chat: ChatRecord = {
    id: crypto.randomUUID(), title: cleanTitle(firstMessage), rolling_summary: "", status: "active", pinned: 0,
    message_count: 0, last_preview: "", summarized_message_count: 0, created_at: now, updated_at: now,
  };
  if (!db) return chat;
  await ensureSchema(db);
  await db.prepare(`INSERT INTO chats
    (id, title, rolling_summary, status, pinned, message_count, last_preview, summarized_message_count, created_at, updated_at)
    VALUES (?, ?, '', 'active', 0, 0, '', 0, ?, ?)`)
    .bind(chat.id, chat.title, now, now).run();
  return chat;
}

export async function getChat(id: string): Promise<ChatRecord | null> {
  const db = database();
  if (!db) return null;
  await ensureSchema(db);
  return db.prepare("SELECT * FROM chats WHERE id = ?").bind(id).first<ChatRecord>();
}

export async function getOrCreateChat(id: string | undefined, firstMessage: string): Promise<{ chat: ChatRecord; created: boolean }> {
  if (id) {
    const existing = await getChat(id);
    if (existing) return { chat: existing, created: false };
  }
  return { chat: await createChat(firstMessage), created: true };
}

export async function listChats(options: { query?: string; status?: string; limit?: number } = {}): Promise<ChatRecord[]> {
  const db = database();
  if (!db) return [];
  await ensureSchema(db);
  const status = options.status === "archived" ? "archived" : "active";
  const limit = Math.min(200, Math.max(1, options.limit ?? 100));
  const query = options.query?.trim();
  if (query) {
    return (await db.prepare(`SELECT * FROM chats WHERE status = ? AND (title LIKE ? OR last_preview LIKE ? OR rolling_summary LIKE ?)
      ORDER BY pinned DESC, updated_at DESC LIMIT ?`)
      .bind(status, `%${query}%`, `%${query}%`, `%${query}%`, limit).all<ChatRecord>()).results ?? [];
  }
  return (await db.prepare("SELECT * FROM chats WHERE status = ? ORDER BY pinned DESC, updated_at DESC LIMIT ?")
    .bind(status, limit).all<ChatRecord>()).results ?? [];
}

export async function updateChat(id: string, patch: { title?: string; pinned?: boolean; status?: "active" | "archived" }): Promise<ChatRecord | null> {
  const db = database();
  if (!db) return null;
  await ensureSchema(db);
  if (typeof patch.title === "string") await db.prepare("UPDATE chats SET title = ?, updated_at = ? WHERE id = ?").bind(cleanTitle(patch.title), Date.now(), id).run();
  if (typeof patch.pinned === "boolean") await db.prepare("UPDATE chats SET pinned = ?, updated_at = ? WHERE id = ?").bind(patch.pinned ? 1 : 0, Date.now(), id).run();
  if (patch.status) await db.prepare("UPDATE chats SET status = ?, updated_at = ? WHERE id = ?").bind(patch.status, Date.now(), id).run();
  return getChat(id);
}

export async function deleteChat(id: string): Promise<boolean> {
  const db = database();
  if (!db) return false;
  await ensureSchema(db);
  await db.prepare("DELETE FROM message_feedback WHERE message_id IN (SELECT id FROM chat_messages WHERE chat_id = ?)").bind(id).run();
  await db.prepare("DELETE FROM chat_messages WHERE chat_id = ?").bind(id).run();
  const result = await db.prepare("DELETE FROM chats WHERE id = ?").bind(id).run();
  return Boolean(result.meta.changes);
}

export async function appendMessage(input: {
  id?: string; chatId: string; role: "user" | "assistant"; content: string; metadata?: MessageMetadata;
  promptTokens?: number; responseTokens?: number;
}): Promise<StoredChatMessage | null> {
  const db = database();
  if (!db) return null;
  await ensureSchema(db);
  const id = input.id || crypto.randomUUID();
  const existing = await db.prepare("SELECT id FROM chat_messages WHERE id = ?").bind(id).first<{ id: string }>();
  if (!existing) {
    const sequence = await db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM chat_messages WHERE chat_id = ?")
      .bind(input.chatId).first<{ next: number }>();
    const now = Date.now();
    await db.prepare(`INSERT INTO chat_messages
      (id, chat_id, sequence, role, content, metadata_json, prompt_tokens, response_tokens, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, input.chatId, sequence?.next ?? 1, input.role, input.content.slice(0, 100_000), JSON.stringify(input.metadata ?? {}), input.promptTokens ?? 0, input.responseTokens ?? 0, now).run();
    await db.prepare(`UPDATE chats SET message_count = message_count + 1, last_preview = ?, updated_at = ?,
      title = CASE WHEN message_count = 0 AND ? = 'user' THEN ? ELSE title END WHERE id = ?`)
      .bind(input.content.replace(/\s+/g, " ").trim().slice(0, 180), now, input.role, cleanTitle(input.content), input.chatId).run();
  }
  return getMessage(id);
}

export async function getMessage(id: string): Promise<StoredChatMessage | null> {
  const db = database();
  if (!db) return null;
  await ensureSchema(db);
  const row = await db.prepare("SELECT * FROM chat_messages WHERE id = ?").bind(id).first<Omit<StoredChatMessage, "metadata"> & { metadata_json: string }>();
  return row ? { ...row, metadata: parseMetadata(row.metadata_json) } : null;
}

export async function updateMessage(id: string, patch: { content?: string; metadata?: MessageMetadata }): Promise<StoredChatMessage | null> {
  const db = database();
  if (!db) return null;
  await ensureSchema(db);
  const existing = await getMessage(id);
  if (!existing) return null;
  const content = typeof patch.content === "string" ? patch.content.slice(0, 100_000) : existing.content;
  const metadata = { ...existing.metadata, ...(patch.metadata ?? {}) };
  await db.prepare("UPDATE chat_messages SET content = ?, metadata_json = ? WHERE id = ?")
    .bind(content, JSON.stringify(metadata), id).run();
  await db.prepare("UPDATE chats SET last_preview = ?, updated_at = ? WHERE id = ?")
    .bind(content.replace(/\s+/g, " ").trim().slice(0, 180), Date.now(), existing.chat_id).run();
  return getMessage(id);
}

export async function listChatMessages(chatId: string, limit = 1000): Promise<StoredChatMessage[]> {
  const db = database();
  if (!db) return [];
  await ensureSchema(db);
  const rows = (await db.prepare("SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY sequence ASC LIMIT ?")
    .bind(chatId, Math.min(5000, Math.max(1, limit))).all<Omit<StoredChatMessage, "metadata"> & { metadata_json: string }>()).results ?? [];
  return rows.map((row) => ({ ...row, metadata: parseMetadata(row.metadata_json) }));
}

export async function listRecentChatMessages(chatId: string, limit = 12): Promise<StoredChatMessage[]> {
  const db = database();
  if (!db) return [];
  await ensureSchema(db);
  const rows = (await db.prepare("SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY sequence DESC LIMIT ?")
    .bind(chatId, Math.min(40, Math.max(1, limit))).all<Omit<StoredChatMessage, "metadata"> & { metadata_json: string }>()).results ?? [];
  return rows.reverse().map((row) => ({ ...row, metadata: parseMetadata(row.metadata_json) }));
}

export async function saveChatSummary(chatId: string, summary: string, summarizedMessageCount: number): Promise<void> {
  const db = database();
  if (!db) return;
  await ensureSchema(db);
  await db.prepare("UPDATE chats SET rolling_summary = ?, summarized_message_count = ?, updated_at = ? WHERE id = ?")
    .bind(summary.trim().slice(0, 12_000), summarizedMessageCount, Date.now(), chatId).run();
}

export async function findRelevantChatSummaries(query: string, excludeChatId: string, limit = 3): Promise<ChatRecord[]> {
  const candidates = [
    ...await listChats({ status: "active", limit: 250 }),
    ...await listChats({ status: "archived", limit: 250 }),
  ].filter((chat) => chat.id !== excludeChatId && chat.rolling_summary);
  const queryGrams = grams(query);
  return candidates.map((chat) => {
    const haystack = grams(`${chat.title} ${chat.rolling_summary}`);
    let matches = 0;
    for (const gram of queryGrams) if (haystack.has(gram)) matches += 1;
    return { chat, score: queryGrams.size ? matches / queryGrams.size : 0 };
  }).filter((item) => item.score >= 0.1)
    .sort((a, b) => b.score - a.score || b.chat.updated_at - a.chat.updated_at)
    .slice(0, limit).map((item) => item.chat);
}

export async function saveFeedback(input: { messageId: string; rating: 1 | -1; correction?: string; rememberCorrection?: boolean }) {
  const db = database();
  if (!db) return null;
  await ensureSchema(db);
  const now = Date.now();
  const correction = input.correction?.trim().slice(0, 4000) ?? "";
  await db.prepare(`INSERT INTO message_feedback (id, message_id, rating, correction, remember_correction, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET rating = excluded.rating, correction = excluded.correction,
      remember_correction = excluded.remember_correction, updated_at = excluded.updated_at`)
    .bind(crypto.randomUUID(), input.messageId, input.rating, correction, input.rememberCorrection ? 1 : 0, now, now).run();
  return { message_id: input.messageId, rating: input.rating, correction, remember_correction: Boolean(input.rememberCorrection) };
}

export function estimateTokens(messages: Array<{ content: string }>): number {
  return Math.ceil(messages.reduce((total, item) => total + item.content.length, 0) / 3);
}
