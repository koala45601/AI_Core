import { env } from "cloudflare:workers";

interface RuntimeEnv { DB?: D1Database }

export interface TicketScheduleCacheRecord {
  schema_version?: number;
  source_url: string;
  event_id: string;
  event_name: string;
  event_url: string;
  show_dates: Array<{ raw?: string; iso?: string }>;
  performance_options: Array<{ schedule?: string; label?: string; context_text?: string; product_name?: string; product_type?: string; status?: string; selectable?: boolean }>;
  sale_open_at: string;
  queue_open_at: string;
  updated_at: number;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ticket_event_schedule_cache (
    source_url TEXT NOT NULL, event_id TEXT NOT NULL, event_name TEXT NOT NULL,
    event_url TEXT NOT NULL, show_dates_json TEXT NOT NULL DEFAULT '[]',
    performance_options_json TEXT NOT NULL DEFAULT '[]', sale_open_at TEXT NOT NULL DEFAULT '',
    queue_open_at TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL,
    PRIMARY KEY(source_url, event_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ticket_event_schedule_cache_updated_at ON ticket_event_schedule_cache(updated_at DESC)`,
];

const CACHE_SCHEMA_VERSION = 2;

function database(): D1Database | undefined {
  return (env as unknown as RuntimeEnv).DB;
}

async function ensureSchema(db: D1Database) {
  for (const statement of SCHEMA) await db.prepare(statement).run();
  const columns = await db.prepare("PRAGMA table_info(ticket_event_schedule_cache)").all<{ name: string }>();
  if (!(columns.results || []).some((column) => column.name === "schema_version")) {
    await db.prepare("ALTER TABLE ticket_event_schedule_cache ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1").run();
  }
}

function parseList<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

export async function loadTicketScheduleCache(sourceUrl: string): Promise<Map<string, TicketScheduleCacheRecord>> {
  const db = database();
  if (!db) return new Map();
  await ensureSchema(db);
  const rows = await db.prepare(`SELECT source_url, event_id, event_name, event_url, show_dates_json,
    performance_options_json, sale_open_at, queue_open_at, updated_at, schema_version
    FROM ticket_event_schedule_cache WHERE source_url = ? AND schema_version = ? ORDER BY updated_at DESC`).bind(sourceUrl, CACHE_SCHEMA_VERSION).all<{
      source_url: string; event_id: string; event_name: string; event_url: string; show_dates_json: string;
      performance_options_json: string; sale_open_at: string; queue_open_at: string; updated_at: number; schema_version: number;
    }>();
  return new Map((rows.results || []).map((row) => [row.event_id, {
    source_url: row.source_url,
    schema_version: row.schema_version,
    event_id: row.event_id,
    event_name: row.event_name,
    event_url: row.event_url,
    show_dates: parseList(row.show_dates_json),
    performance_options: parseList(row.performance_options_json),
    sale_open_at: row.sale_open_at,
    queue_open_at: row.queue_open_at,
    updated_at: row.updated_at,
  }]));
}

export async function saveTicketScheduleCache(records: TicketScheduleCacheRecord[]): Promise<void> {
  const db = database();
  if (!db || !records.length) return;
  await ensureSchema(db);
  await db.batch(records.slice(0, 100).map((record) => db.prepare(`
    INSERT INTO ticket_event_schedule_cache
      (source_url, event_id, event_name, event_url, show_dates_json, performance_options_json, sale_open_at, queue_open_at, updated_at, schema_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_url, event_id) DO UPDATE SET
      event_name=excluded.event_name, event_url=excluded.event_url,
      show_dates_json=excluded.show_dates_json, performance_options_json=excluded.performance_options_json,
      sale_open_at=excluded.sale_open_at, queue_open_at=excluded.queue_open_at,
      updated_at=excluded.updated_at, schema_version=excluded.schema_version
  `).bind(
    record.source_url, record.event_id, record.event_name, record.event_url,
    JSON.stringify(record.show_dates), JSON.stringify(record.performance_options),
    record.sale_open_at, record.queue_open_at, record.updated_at, CACHE_SCHEMA_VERSION,
  )));
}
