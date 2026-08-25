import { env } from "cloudflare:workers";

interface RuntimeEnv {
  DB?: D1Database;
}

export type CreateVideoMode = "auto" | "manual";
export type CreateVideoProjectStatus = "DRAFT" | "PLANNING" | "STORYBOARD" | "WAITING" | "COMPLETED" | "FAILED" | "CANCELLED";

export interface CreateVideoVisualSettings {
  style: string;
  aspect_ratio: string;
  resolution: string;
  fps: number;
  quality: string;
  seed: number | null;
  negative_prompt: string;
}

export interface CreateVideoProject {
  id: string;
  name: string;
  story: string;
  screenplay: string;
  target_duration_seconds: number;
  mode: CreateVideoMode;
  visual: CreateVideoVisualSettings;
  plan: Record<string, unknown> | null;
  status: CreateVideoProjectStatus;
  created_at: number;
  updated_at: number;
}

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS create_video_projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    story TEXT NOT NULL DEFAULT '',
    screenplay TEXT NOT NULL DEFAULT '',
    target_duration_seconds INTEGER NOT NULL DEFAULT 60,
    mode TEXT NOT NULL DEFAULT 'auto',
    visual_json TEXT NOT NULL DEFAULT '{}',
    plan_json TEXT,
    status TEXT NOT NULL DEFAULT 'DRAFT',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`;

function database(): D1Database {
  const db = (env as unknown as RuntimeEnv).DB;
  if (!db) throw new Error("Create Video storage ยังไม่พร้อม: ไม่พบ D1 binding DB");
  return db;
}

async function ensureTable(db: D1Database) {
  await db.prepare(CREATE_TABLE).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_create_video_projects_updated ON create_video_projects(updated_at DESC)").run();
}

function safeJson<T>(value: unknown, fallback: T): T {
  try {
    if (typeof value !== "string" || !value.trim()) return fallback;
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToProject(row: Record<string, unknown>): CreateVideoProject {
  return {
    id: String(row.id || ""),
    name: String(row.name || "Untitled Video"),
    story: String(row.story || ""),
    screenplay: String(row.screenplay || ""),
    target_duration_seconds: Math.max(1, Number(row.target_duration_seconds || 60)),
    mode: row.mode === "manual" ? "manual" : "auto",
    visual: safeJson<CreateVideoVisualSettings>(row.visual_json, defaultVisualSettings()),
    plan: safeJson<Record<string, unknown> | null>(row.plan_json, null),
    status: normalizeStatus(row.status),
    created_at: Number(row.created_at || 0),
    updated_at: Number(row.updated_at || 0),
  };
}

function normalizeStatus(value: unknown): CreateVideoProjectStatus {
  const text = String(value || "DRAFT").toUpperCase();
  return new Set(["DRAFT", "PLANNING", "STORYBOARD", "WAITING", "COMPLETED", "FAILED", "CANCELLED"]).has(text)
    ? text as CreateVideoProjectStatus
    : "DRAFT";
}

function cleanText(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function defaultVisualSettings(): CreateVideoVisualSettings {
  return {
    style: "cinematic",
    aspect_ratio: "16:9",
    resolution: "1280x720",
    fps: 24,
    quality: "balanced",
    seed: null,
    negative_prompt: "",
  };
}

function normalizeVisual(value: unknown): CreateVideoVisualSettings {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const allowedRatios = new Set(["16:9", "9:16", "1:1", "custom"]);
  const allowedResolutions = new Set(["854x480", "1280x720", "1920x1080"]);
  const allowedQuality = new Set(["fast", "balanced", "quality"]);
  const fps = [12, 15, 24, 25, 30].includes(Number(source.fps)) ? Number(source.fps) : 24;
  const seedNumber = Number(source.seed);
  return {
    style: cleanText(source.style, 120) || "cinematic",
    aspect_ratio: allowedRatios.has(String(source.aspect_ratio)) ? String(source.aspect_ratio) : "16:9",
    resolution: allowedResolutions.has(String(source.resolution)) ? String(source.resolution) : "1280x720",
    fps,
    quality: allowedQuality.has(String(source.quality)) ? String(source.quality) : "balanced",
    seed: Number.isSafeInteger(seedNumber) && seedNumber >= 0 ? seedNumber : null,
    negative_prompt: cleanText(source.negative_prompt, 2_000),
  };
}

export async function listCreateVideoProjects(limit = 100): Promise<CreateVideoProject[]> {
  const db = database();
  await ensureTable(db);
  const result = await db.prepare(`SELECT * FROM create_video_projects ORDER BY updated_at DESC LIMIT ?`)
    .bind(Math.min(200, Math.max(1, limit))).all<Record<string, unknown>>();
  return (result.results ?? []).map(rowToProject);
}

export async function getCreateVideoProject(id: string): Promise<CreateVideoProject | null> {
  const db = database();
  await ensureTable(db);
  const row = await db.prepare("SELECT * FROM create_video_projects WHERE id = ?").bind(id).first<Record<string, unknown>>();
  return row ? rowToProject(row) : null;
}

export async function createCreateVideoProject(input: Record<string, unknown>): Promise<CreateVideoProject> {
  const db = database();
  await ensureTable(db);
  const id = crypto.randomUUID();
  const now = Date.now();
  const name = cleanText(input.name, 160) || "Untitled Video";
  const story = cleanText(input.story, 20_000);
  const screenplay = cleanText(input.screenplay, 80_000);
  if (!story && !screenplay) throw new Error("กรุณาใส่ Story หรือ Screenplay ก่อนสร้าง Project");
  const target = Math.min(1_800, Math.max(5, Math.round(Number(input.target_duration_seconds || 60))));
  const mode: CreateVideoMode = input.mode === "manual" ? "manual" : "auto";
  const visual = normalizeVisual(input.visual);
  await db.prepare(`
    INSERT INTO create_video_projects
      (id, name, story, screenplay, target_duration_seconds, mode, visual_json, plan_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'DRAFT', ?, ?)
  `).bind(id, name, story, screenplay, target, mode, JSON.stringify(visual), now, now).run();
  const project = await getCreateVideoProject(id);
  if (!project) throw new Error("สร้าง Create Video Project แล้วแต่โหลดกลับมาไม่สำเร็จ");
  return project;
}

export async function updateCreateVideoProject(id: string, patch: Record<string, unknown>): Promise<CreateVideoProject> {
  const current = await getCreateVideoProject(id);
  if (!current) throw new Error("ไม่พบ Create Video Project");
  const next = {
    name: cleanText(patch.name, 160) || current.name,
    story: patch.story === undefined ? current.story : cleanText(patch.story, 20_000),
    screenplay: patch.screenplay === undefined ? current.screenplay : cleanText(patch.screenplay, 80_000),
    target_duration_seconds: patch.target_duration_seconds === undefined
      ? current.target_duration_seconds
      : Math.min(1_800, Math.max(5, Math.round(Number(patch.target_duration_seconds || 60)))),
    mode: patch.mode === undefined ? current.mode : patch.mode === "manual" ? "manual" : "auto",
    visual: patch.visual === undefined ? current.visual : normalizeVisual(patch.visual),
    plan: patch.plan === undefined
      ? current.plan
      : patch.plan && typeof patch.plan === "object" && !Array.isArray(patch.plan) ? patch.plan as Record<string, unknown> : null,
    status: patch.status === undefined ? current.status : normalizeStatus(patch.status),
  };
  const db = database();
  await ensureTable(db);
  await db.prepare(`
    UPDATE create_video_projects
    SET name = ?, story = ?, screenplay = ?, target_duration_seconds = ?, mode = ?, visual_json = ?, plan_json = ?, status = ?, updated_at = ?
    WHERE id = ?
  `).bind(
    next.name, next.story, next.screenplay, next.target_duration_seconds, next.mode,
    JSON.stringify(next.visual), next.plan ? JSON.stringify(next.plan) : null, next.status, Date.now(), id,
  ).run();
  const project = await getCreateVideoProject(id);
  if (!project) throw new Error("บันทึก Create Video Project แล้วแต่โหลดกลับมาไม่สำเร็จ");
  return project;
}

export async function saveCreateVideoPlan(id: string, plan: Record<string, unknown>, status: CreateVideoProjectStatus = "WAITING") {
  return updateCreateVideoProject(id, { plan, status });
}
