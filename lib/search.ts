import { domainAllowed } from "./policy.js";
import { executeTool } from "./tool-client";
import { AppSettings, SearchResult } from "./types";

export class SearchUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchUnavailableError";
  }
}

export function hasSearchKey(): boolean {
  return true;
}

export interface SearchResponse {
  results: SearchResult[];
  backend: "searxng" | "duckduckgo" | "none";
  degraded_reason: string;
}

export async function searchWebDetailed(query: string, settings: AppSettings): Promise<SearchResponse> {
  try {
    const payload = await executeTool("web_search", { query: query.slice(0, 400) }, settings);
    const raw = Array.isArray(payload.results) ? payload.results as Array<Record<string, unknown>> : [];
    return {
      results: raw
        .filter((item) => Boolean(item.title && item.url))
        .filter((item) => domainAllowed(String(item.url), settings))
        .slice(0, settings.search_result_limit || undefined)
        .map((item) => ({ title: String(item.title), url: String(item.url), snippet: String(item.snippet || "") })),
      backend: payload.backend === "searxng" ? "searxng" : payload.backend === "duckduckgo" ? "duckduckgo" : "none",
      degraded_reason: String(payload.degraded_reason || ""),
    };
  } catch (error) {
    throw new SearchUnavailableError(error instanceof Error ? error.message : "ค้นเว็บไม่สำเร็จ");
  }
}

export async function searchWeb(query: string, settings: AppSettings): Promise<SearchResult[]> {
  return (await searchWebDetailed(query, settings)).results;
}
