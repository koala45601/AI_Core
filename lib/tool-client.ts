import { env } from "cloudflare:workers";
import { AppSettings, ArtifactRecord, ToolHealth } from "./types";

interface RuntimeEnv {
  ALPHA_TOOL_BASE_URL?: string;
  ALPHA_TOOL_TOKEN?: string;
}

function runtimeEnv(): RuntimeEnv {
  return env as unknown as RuntimeEnv;
}

function baseUrl(): string {
  return (runtimeEnv().ALPHA_TOOL_BASE_URL?.trim() || "http://127.0.0.1:4317").replace(/\/$/, "");
}

function headers(contentType = true): HeadersInit {
  return {
    ...(contentType ? { "Content-Type": "application/json" } : {}),
    Authorization: `Bearer ${runtimeEnv().ALPHA_TOOL_TOKEN?.trim() || "missing"}`,
  };
}

export class ToolServiceError extends Error {
  status: number;
  payload: Record<string, unknown>;

  constructor(message: string, status: number, payload: Record<string, unknown> = {}) {
    super(message);
    this.name = "ToolServiceError";
    this.status = status;
    this.payload = payload;
  }
}

async function toolFetch(path: string, init: RequestInit = {}, timeout = 190_000): Promise<Response> {
  return fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: { ...headers(Boolean(init.body)), ...(init.headers || {}) },
    signal: init.signal ?? AbortSignal.timeout(timeout),
  });
}

async function payload(response: Response): Promise<Record<string, unknown>> {
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok && response.status !== 409) {
    throw new ToolServiceError(String(data.error || `เครื่องมือตอบกลับ ${response.status}`), response.status, data);
  }
  return data;
}

export async function getToolHealth(): Promise<ToolHealth> {
  try {
    const response = await toolFetch("/v1/health", { method: "GET", headers: headers(false) }, 2500);
    if (!response.ok) throw new Error("tool health failed");
    return await response.json() as ToolHealth;
  } catch {
    return {
      connected: false,
      docker_connected: false,
      searxng_connected: false,
      alpha_browser_running: false,
      chrome_extension_connected: false,
      full_disk_access: "not_requested",
      outputs_directory: "",
      web_read_ready: false,
      search_ready: false,
      search_backend: "none",
      search_degraded_reason: "Tool Service ยังไม่ทำงาน",
      browser_ready: false,
      last_tool_error: "",
    };
  }
}

export interface ToolExecutionResult extends Record<string, unknown> {
  ok?: boolean;
  confirmation_required?: boolean;
  confirmation_id?: string;
  summary?: string;
  artifacts?: ArtifactRecord[];
}

export async function executeTool(name: string, args: Record<string, unknown>, settings: AppSettings, signal?: AbortSignal): Promise<ToolExecutionResult> {
  const response = await toolFetch("/v1/tool/execute", {
    method: "POST",
    body: JSON.stringify({ name, arguments: args, settings }),
    signal,
  });
  return await payload(response) as ToolExecutionResult;
}

export async function confirmTool(confirmationId: string, approved: boolean): Promise<ToolExecutionResult> {
  const response = await toolFetch("/v1/tools/confirm", {
    method: "POST",
    body: JSON.stringify({ confirmation_id: confirmationId, approved }),
  }, 20 * 60_000 + 30_000);
  return await payload(response) as ToolExecutionResult;
}

export async function getHostConfirmationStatus(confirmationId: string): Promise<Record<string, unknown>> {
  const response = await toolFetch(`/v1/host/confirmations/${encodeURIComponent(confirmationId)}`, {
    method: "GET",
    headers: headers(false),
  }, 5000);
  return payload(response);
}

export async function getPairingCode(): Promise<string> {
  const response = await toolFetch("/v1/extension/pairing", { method: "GET", headers: headers(false) }, 2500);
  const data = await payload(response);
  return String(data.code || "");
}

export async function artifactResponse(id: string): Promise<Response> {
  return toolFetch(`/v1/artifacts/${encodeURIComponent(id)}`, { method: "GET", headers: headers(false) }, 30_000);
}

export async function openArtifact(id: string): Promise<void> {
  const response = await toolFetch(`/v1/artifacts/${encodeURIComponent(id)}/open`, { method: "POST", body: "{}" }, 5000);
  await payload(response);
}

export async function getAutoLearnStatus(): Promise<Record<string, unknown>> {
  const response = await toolFetch("/v1/auto-learn/status", { method: "GET", headers: headers(false) }, 5000);
  return payload(response);
}

export async function startAutoLearn(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await toolFetch("/v1/auto-learn/start", { method: "POST", body: JSON.stringify(input) }, 10_000);
  return payload(response);
}

export async function stopAutoLearn(): Promise<Record<string, unknown>> {
  const response = await toolFetch("/v1/auto-learn/stop", { method: "POST", body: "{}" }, 10_000);
  return payload(response);
}

export async function acknowledgeAutoLearn(): Promise<void> {
  const response = await toolFetch("/v1/auto-learn/ack", { method: "POST", body: "{}" }, 5000);
  await payload(response);
}

export async function autoLearnRequest(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await toolFetch(`/v1/auto-learn${path}`, init, 30_000);
  return payload(response);
}

export async function skillsRequest(path = "", init: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await toolFetch(`/v1/skills${path}`, init, 190_000);
  return payload(response);
}

// alpha-beta21-ticket-runtime-v1
export interface TicketRunView extends Record<string, unknown> {
  id: string;
  project_path: string;
  pid?: number | null;
  status: string;
  stage: string;
  detail?: string;
  logs?: Array<{ at: number; stream: string; text: string }>;
  handoff?: { field?: string; prompt?: string; options?: string[]; secret?: boolean } | null;
}

export async function startTicketRun(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await toolFetch("/v1/ticket-runs", { method: "POST", body: JSON.stringify(input) }, 15_000);
  return payload(response);
}

export async function getTicketRun(id: string): Promise<Record<string, unknown>> {
  const response = await toolFetch(`/v1/ticket-runs/${encodeURIComponent(id)}`, { method: "GET", headers: headers(false) }, 5_000);
  return payload(response);
}

export async function sendTicketRunInput(id: string, value = ""): Promise<Record<string, unknown>> {
  const response = await toolFetch(`/v1/ticket-runs/${encodeURIComponent(id)}/input`, { method: "POST", body: JSON.stringify({ value }) }, 5_000);
  return payload(response);
}

export async function stopTicketRun(id: string): Promise<Record<string, unknown>> {
  const response = await toolFetch(`/v1/ticket-runs/${encodeURIComponent(id)}/stop`, { method: "POST", body: "{}" }, 10_000);
  return payload(response);
}

// alpha-beta24-create-video-local-v1
export interface VideoRunView extends Record<string, unknown> {
  id: string;
  kind: "prepare" | "generate";
  status: string;
  stage: string;
  detail?: string;
  progress?: number;
  pid?: number | null;
  output_path?: string | null;
  output_name?: string | null;
  logs?: Array<{ at: number; stream: string; text: string }>;
}

export async function getVideoRuntimeStatus(): Promise<Record<string, unknown>> {
  const response = await toolFetch("/v1/video-runtime/status", { method: "GET", headers: headers(false) }, 5000);
  return payload(response);
}

export async function startVideoRun(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await toolFetch("/v1/video-runs", { method: "POST", body: JSON.stringify(input) }, 15_000);
  return payload(response);
}

export async function getVideoRun(id: string): Promise<Record<string, unknown>> {
  const response = await toolFetch(`/v1/video-runs/${encodeURIComponent(id)}`, { method: "GET", headers: headers(false) }, 5000);
  return payload(response);
}

export async function stopVideoRun(id: string): Promise<Record<string, unknown>> {
  const response = await toolFetch(`/v1/video-runs/${encodeURIComponent(id)}/stop`, { method: "POST", body: "{}" }, 10_000);
  return payload(response);
}

export async function videoRunFileResponse(id: string): Promise<Response> {
  return toolFetch(`/v1/video-runs/${encodeURIComponent(id)}/file`, { method: "GET", headers: headers(false) }, 30_000);
}
