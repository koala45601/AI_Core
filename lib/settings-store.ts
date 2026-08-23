import { env } from "cloudflare:workers";
import { AppSettings, DEFAULT_SETTINGS, sanitizeSettings } from "./types";

interface RuntimeEnv {
  DB?: D1Database;
}

const CREATE_SETTINGS_TABLE = `
  CREATE TABLE IF NOT EXISTS app_settings (
    id TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )
`;

function database(): D1Database | undefined {
  return (env as unknown as RuntimeEnv).DB;
}

async function ensureTable(db: D1Database) {
  await db.prepare(CREATE_SETTINGS_TABLE).run();
}

export async function getSettings(): Promise<AppSettings> {
  const db = database();
  if (!db) return DEFAULT_SETTINGS;

  await ensureTable(db);
  const row = await db.prepare("SELECT value FROM app_settings WHERE id = ?")
    .bind("default")
    .first<{ value: string }>();

  if (!row) return DEFAULT_SETTINGS;

  try {
    return sanitizeSettings(JSON.parse(row.value));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(input: unknown): Promise<{ previous: AppSettings; settings: AppSettings }> {
  const previous = await getSettings();
  const settings = sanitizeSettings(input, previous);
  const db = database();

  if (db) {
    await ensureTable(db);
    await db.prepare(`
      INSERT INTO app_settings (id, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).bind("default", JSON.stringify(settings), Date.now()).run();
  }

  return { previous, settings };
}
