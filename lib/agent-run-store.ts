import { env } from "cloudflare:workers";

interface RuntimeEnv { DB?: D1Database }

export type AgentRunStatus = "queued" | "running" | "waiting_approval" | "completed" | "failed" | "blocked";

export interface AgentRunRecord {
  id: string;
  chat_id: string;
  status: AgentRunStatus;
  stage: string;
  label: string;
  detail: string;
  tool: string;
  started_at: number;
  updated_at: number;
  finished_at: number;
}

const memoryRuns = new Map<string, AgentRunRecord>();
const SCHEMA = `CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY NOT NULL,
  chat_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  stage TEXT NOT NULL DEFAULT 'queued',
  label TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  tool TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL DEFAULT 0
)`;

function database(): D1Database | undefined {
  return (env as unknown as RuntimeEnv).DB;
}

async function ensureSchema(db: D1Database) {
  await db.prepare(SCHEMA).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_agent_runs_updated_at ON agent_runs(updated_at DESC)").run();
}

export async function startAgentRun(id: string, chatId = "", label = "รับคำขอแล้ว"): Promise<AgentRunRecord> {
  const now = Date.now();
  const run: AgentRunRecord = {
    id,
    chat_id: chatId,
    status: "running",
    stage: "received",
    label,
    detail: "",
    tool: "",
    started_at: now,
    updated_at: now,
    finished_at: 0,
  };
  memoryRuns.set(id, run);
  const db = database();
  if (db) {
    await ensureSchema(db);
    await db.prepare(`INSERT INTO agent_runs
      (id, chat_id, status, stage, label, detail, tool, started_at, updated_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(id) DO UPDATE SET chat_id=excluded.chat_id, status=excluded.status, stage=excluded.stage,
      label=excluded.label, detail=excluded.detail, tool=excluded.tool, updated_at=excluded.updated_at, finished_at=0`)
      .bind(id, chatId, run.status, run.stage, run.label, run.detail, run.tool, now, now).run();
  }
  return run;
}

export async function updateAgentRun(id: string, patch: Partial<Pick<AgentRunRecord, "chat_id" | "status" | "stage" | "label" | "detail" | "tool" | "finished_at">>): Promise<AgentRunRecord | null> {
  const existing = await getAgentRun(id);
  if (!existing) return null;
  const next: AgentRunRecord = {
    ...existing,
    ...patch,
    updated_at: Date.now(),
  };
  memoryRuns.set(id, next);
  const db = database();
  if (db) {
    await ensureSchema(db);
    await db.prepare(`UPDATE agent_runs SET chat_id=?, status=?, stage=?, label=?, detail=?, tool=?, updated_at=?, finished_at=? WHERE id=?`)
      .bind(next.chat_id, next.status, next.stage, next.label, next.detail, next.tool, next.updated_at, next.finished_at, id).run();
  }
  return next;
}

export async function finishAgentRun(id: string, status: Extract<AgentRunStatus, "completed" | "failed" | "blocked">, label: string, detail = ""): Promise<AgentRunRecord | null> {
  return updateAgentRun(id, {
    status,
    stage: status,
    label,
    detail,
    tool: "",
    finished_at: Date.now(),
  });
}

export async function getAgentRun(id: string): Promise<AgentRunRecord | null> {
  const db = database();
  if (db) {
    await ensureSchema(db);
    const row = await db.prepare("SELECT * FROM agent_runs WHERE id = ?").bind(id).first<AgentRunRecord>();
    if (row) {
      memoryRuns.set(id, row);
      return row;
    }
  }
  return memoryRuns.get(id) ?? null;
}
