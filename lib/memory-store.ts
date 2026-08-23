import { env } from "cloudflare:workers";

interface RuntimeEnv {
  DB?: D1Database;
}

export interface MemoryRecord {
  id: number;
  content: string;
  source: "manual" | "auto" | "research" | "correction";
  category: "general" | "profile" | "preference" | "project" | "correction" | "research";
  source_chat_id: string | null;
  confidence: number;
  pinned: number;
  last_used_at: number | null;
  updated_at: number;
  created_at: number;
}

const CREATE_MEMORY_TABLE = `
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    normalized_content TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL DEFAULT 'manual',
    category TEXT NOT NULL DEFAULT 'general',
    source_chat_id TEXT,
    confidence INTEGER NOT NULL DEFAULT 80,
    pinned INTEGER NOT NULL DEFAULT 0,
    last_used_at INTEGER,
    updated_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )
`;

function database(): D1Database | undefined {
  return (env as unknown as RuntimeEnv).DB;
}

async function ensureTable(db: D1Database) {
  await db.prepare(CREATE_MEMORY_TABLE).run();
  const upgrades = [
    "ALTER TABLE memories ADD COLUMN category TEXT NOT NULL DEFAULT 'general'",
    "ALTER TABLE memories ADD COLUMN source_chat_id TEXT",
    "ALTER TABLE memories ADD COLUMN confidence INTEGER NOT NULL DEFAULT 80",
    "ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE memories ADD COLUMN last_used_at INTEGER",
    "ALTER TABLE memories ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0",
  ];
  for (const statement of upgrades) await db.prepare(statement).run().catch(() => undefined);
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at DESC)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_memories_pinned ON memories(pinned DESC)").run();
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function terms(value: string): Set<string> {
  return new Set(normalize(value).split(/[^\p{L}\p{N}_]+/u).filter((term) => term.length > 1));
}

function characterGrams(value: string): Set<string> {
  const compact = normalize(value).replace(/[^\p{L}\p{N}]+/gu, "");
  const grams = new Set<string>();
  for (let index = 0; index <= compact.length - 3; index += 1) {
    grams.add(compact.slice(index, index + 3));
  }
  return grams;
}

export async function listMemories(limit = 100): Promise<MemoryRecord[]> {
  const db = database();
  if (!db) return [];
  await ensureTable(db);
  const result = await db.prepare(`
    SELECT id, content, source, category, source_chat_id, confidence, pinned, last_used_at, updated_at, created_at
    FROM memories
    ORDER BY pinned DESC, updated_at DESC, created_at DESC
    LIMIT ?
  `).bind(Math.min(200, Math.max(1, limit))).all<MemoryRecord>();
  return result.results ?? [];
}

export function containsSensitiveMemory(value: string): boolean {
  const normalized = normalize(value);
  return /(password|passcode|รหัสผ่าน|otp|one[- ]?time|cvv|cvc|เลขบัตร|credit card|debit card|บัตรเครดิต|seed phrase|private key|api[_ -]?key|access[_ -]?token)/i.test(normalized)
    || /(?:\d[ -]*?){13,19}/.test(normalized);
}

export async function addMemory(
  content: string,
  source: "manual" | "auto" | "research" | "correction" = "manual",
  options: { category?: MemoryRecord["category"]; sourceChatId?: string; confidence?: number; pinned?: boolean } = {},
): Promise<MemoryRecord | null> {
  const cleaned = content.trim().slice(0, 2000);
  if (!cleaned || (source !== "manual" && containsSensitiveMemory(cleaned))) return null;
  const db = database();
  if (!db) return null;
  await ensureTable(db);
  const normalized = normalize(cleaned);
  await db.prepare(`
    INSERT INTO memories (content, normalized_content, source, category, source_chat_id, confidence, pinned, updated_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(normalized_content) DO UPDATE SET content = excluded.content, source = excluded.source,
      category = excluded.category, source_chat_id = COALESCE(excluded.source_chat_id, memories.source_chat_id),
      confidence = MAX(memories.confidence, excluded.confidence), pinned = MAX(memories.pinned, excluded.pinned), updated_at = excluded.updated_at
  `).bind(
    cleaned, normalized, source, options.category ?? (source === "research" ? "research" : source === "correction" ? "correction" : "general"),
    options.sourceChatId ?? null, Math.min(100, Math.max(0, options.confidence ?? 80)), options.pinned ? 1 : 0, Date.now(), Date.now(),
  ).run();
  return db.prepare(`
    SELECT id, content, source, category, source_chat_id, confidence, pinned, last_used_at, updated_at, created_at
    FROM memories WHERE normalized_content = ?
  `).bind(normalized).first<MemoryRecord>();
}

export async function updateMemory(id: number, patch: { content?: string; pinned?: boolean; category?: MemoryRecord["category"] }): Promise<MemoryRecord | null> {
  const db = database();
  if (!db) return null;
  await ensureTable(db);
  if (typeof patch.content === "string") {
    const cleaned = patch.content.trim().slice(0, 2000);
    if (!cleaned) return null;
    await db.prepare("UPDATE memories SET content = ?, normalized_content = ?, updated_at = ? WHERE id = ?")
      .bind(cleaned, normalize(cleaned), Date.now(), id).run();
  }
  if (typeof patch.pinned === "boolean") await db.prepare("UPDATE memories SET pinned = ?, updated_at = ? WHERE id = ?").bind(patch.pinned ? 1 : 0, Date.now(), id).run();
  if (patch.category) await db.prepare("UPDATE memories SET category = ?, updated_at = ? WHERE id = ?").bind(patch.category, Date.now(), id).run();
  return db.prepare(`SELECT id, content, source, category, source_chat_id, confidence, pinned, last_used_at, updated_at, created_at
    FROM memories WHERE id = ?`).bind(id).first<MemoryRecord>();
}

export async function deleteMemory(id: number): Promise<boolean> {
  const db = database();
  if (!db) return false;
  await ensureTable(db);
  const result = await db.prepare("DELETE FROM memories WHERE id = ?").bind(id).run();
  return Boolean(result.meta.changes);
}

export async function findRelevantMemories(query: string, limit = 5): Promise<MemoryRecord[]> {
  const queryTerms = terms(query);
  const queryGrams = characterGrams(query);
  if (!queryTerms.size && !queryGrams.size) return [];
  const memories = await listMemories(200);
  return memories
    .map((memory) => {
      const memoryTerms = terms(memory.content);
      const memoryGrams = characterGrams(memory.content);
      let exactMatches = 0;
      for (const term of queryTerms) if (memoryTerms.has(term)) exactMatches += 1;
      let gramMatches = 0;
      for (const gram of queryGrams) if (memoryGrams.has(gram)) gramMatches += 1;
      const gramSimilarity = queryGrams.size ? gramMatches / queryGrams.size : 0;
      const score = exactMatches * 2 + gramSimilarity;
      return { memory, score: score + (memory.pinned ? 3 : 0) };
    })
    .filter((item) => item.score >= 0.12)
    .sort((a, b) => b.score - a.score || b.memory.created_at - a.memory.created_at)
    .slice(0, limit)
    .map((item) => item.memory);
}
