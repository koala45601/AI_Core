import { domainAllowed } from "@/lib/policy.js";
import { getSettings } from "@/lib/settings-store";
import { executeTool, getTicketRun, sendTicketRunInput, startTicketRun, stopTicketRun, ToolExecutionResult } from "@/lib/tool-client"; // alpha-beta21-ticket-runtime-v1
import { AppSettings } from "@/lib/types";
import { loadTicketScheduleCache, saveTicketScheduleCache, TicketScheduleCacheRecord } from "@/lib/ticket-event-cache";

type TicketAction = "inspect" | "inspect_form" | "build" | "run" | "run_status" | "run_input" | "run_stop";
type TicketSaleStatus = "open" | "upcoming" | "sold_out" | "closed" | "ended" | "cancelled" | "unknown";

interface TicketPerformanceOption {
  schedule: string;
  label: string;
  context_text: string;
  selector: string;
  data_button: string;
  target_url: string;
  product_name: string;
  product_type: string;
  status: string;
  selectable: boolean;
}

interface TicketEvent {
  id: string;
  name: string;
  url: string;
  start_date?: string;
  end_date?: string;
  sale_open_at?: string;
  sale_status?: TicketSaleStatus;
  source?: string;
  selectable?: boolean;
  status_evidence?: string;
  inventory_status?: "not_checked" | "available" | "sold_out" | "unknown";
  inventory_evidence?: string;
  show_dates?: Array<{ raw?: string; iso?: string }>;
  performance_options?: TicketPerformanceOption[];
  queue_open_at?: string;
  schedule_checked_at?: number;
  schedule_status?: "fresh" | "cached" | "unavailable";
  cached_inspection?: Record<string, unknown>;
}

interface TicketBuildInput {
  event_url?: unknown;
  event_candidates?: unknown;
  selected_event_id?: unknown;
  selected_event_name?: unknown;
  schedule?: unknown;
  selected_performance?: unknown;
  sale_open_at?: unknown;
  queue_open_at?: unknown;
  seat_mode?: unknown;
  seat_grouping?: unknown;
  preferred_zones?: unknown;
  preferred_rows?: unknown;
  preferred_seat_numbers?: unknown;
  seat_fallback_mode?: unknown;
  quantity?: unknown;
  budget?: unknown;
  customer_name?: unknown;
  attendee_names?: unknown;
  shipping_address?: unknown;
  delivery_method?: unknown;
  ticket_protect?: unknown;
  payment_method?: unknown;
  selectors?: unknown;
  captured_api?: unknown;
  project_name?: unknown;
  event_facts?: unknown;
  functional_preflight?: unknown;
}

function asText(value: unknown, max = 500): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function publicHttpUrl(value: unknown): string {
  const text = asText(value, 2_000);
  let url: URL;
  try { url = new URL(text); } catch { throw new Error("URL ไม่ถูกต้อง"); }
  if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("รองรับเฉพาะ URL แบบ http/https");
  return url.toString();
}

function assertInternetAndDomain(url: string, settings: AppSettings) {
  if (!settings.web_search_enabled) throw new Error("อินเทอร์เน็ตปิดอยู่ที่ setting web_search_enabled");
  if (settings.browser_mode === "off") throw new Error("Browser Tool ปิดอยู่ กรุณาเลือก Alpha Browser หรือ Chrome ใน Settings");
  if (!domainAllowed(url, settings)) throw new Error("เว็บไซต์นี้ถูกบล็อกโดย blocked_domains หรือไม่อยู่ใน allowed_domains");
}

function canonicalTicketEventUrl(value: unknown): string {
  const text = asText(value, 2_000);
  try {
    const parsed = new URL(text);
    if (parsed.hostname.toLowerCase() === "booking.thaiticketmajor.com" && /^\/concert\//i.test(parsed.pathname)) {
      parsed.hostname = "www.thaiticketmajor.com";
    }
    return parsed.toString();
  } catch {
    return text;
  }
}

function normalizedEvents(result: ToolExecutionResult): TicketEvent[] {
  if (!Array.isArray(result.events)) return [];
  const allowedStatuses = new Set<TicketSaleStatus>(["open", "upcoming", "sold_out", "closed", "ended", "cancelled", "unknown"]);
  return result.events.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const rawId = asText(record.id, 500);
    const name = asText(record.name, 500);
    const url = canonicalTicketEventUrl(record.url);
    const id = /^https?:\/\//i.test(rawId) ? canonicalTicketEventUrl(rawId) : rawId;
    const rawStatus = asText(record.sale_status, 30) as TicketSaleStatus;
    const status = allowedStatuses.has(rawStatus) ? rawStatus : "unknown";
    if (!id || !name || !url) return [];
    return [{
      id,
      name,
      url,
      start_date: asText(record.start_date, 100),
      end_date: asText(record.end_date, 100),
      sale_open_at: asText(record.sale_open_at, 100),
      sale_status: status,
      source: asText(record.source, 50),
      selectable: record.selectable !== false && ["open", "upcoming"].includes(status),
      status_evidence: asText(record.status_evidence, 300),
      inventory_status: asText(record.inventory_status, 30) as TicketEvent["inventory_status"] || "not_checked",
      inventory_evidence: asText(record.inventory_evidence, 300),
    }];
  }).slice(0, 100);
}

function safeCandidates(value: unknown): TicketEvent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const rawId = asText(record.id, 500);
    const name = asText(record.name, 500);
    const url = canonicalTicketEventUrl(record.url);
    const id = /^https?:\/\//i.test(rawId) ? canonicalTicketEventUrl(rawId) : rawId;
    const status = asText(record.sale_status, 30);
    if (!id || !name || !url || !["open", "upcoming"].includes(status) || record.selectable === false) return [];
    return [{
      id, name, url,
      start_date: asText(record.start_date, 100),
      end_date: asText(record.end_date, 100),
      sale_open_at: asText(record.sale_open_at, 100),
      sale_status: status as "open" | "upcoming",
      source: asText(record.source, 50),
      selectable: true,
      status_evidence: asText(record.status_evidence, 300),
      inventory_status: asText(record.inventory_status, 30) as TicketEvent["inventory_status"] || "not_checked",
      inventory_evidence: asText(record.inventory_evidence, 300),
    }];
  }).slice(0, 100);
}

function safeSelectors(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key, selector]) => /^[a-zA-Z0-9_.-]{1,80}$/.test(key) && typeof selector === "string" && selector.length <= 500 && selector.trim())
    .slice(0, 30)
    .map(([key, selector]) => [key, String(selector).trim()]));
}

function safeSelectedPerformance(value: unknown): TicketPerformanceOption | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const performance = {
    schedule: asText(record.schedule, 300),
    label: asText(record.label, 300),
    context_text: asText(record.context_text, 500),
    selector: asText(record.selector, 500),
    data_button: asText(record.data_button, 120),
    target_url: asText(record.target_url, 2_000),
    product_name: asText(record.product_name, 160),
    product_type: asText(record.product_type, 40),
    status: asText(record.status, 30),
    selectable: record.selectable !== false,
  };
  return performance.schedule || performance.context_text || performance.label ? performance : null;
}

function safePerformanceOptions(value: unknown): TicketPerformanceOption[] {
  if (!Array.isArray(value)) return [];
  const options = value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .slice(0, 60)
    .map((item) => ({
      schedule: asText(item.schedule, 300), label: asText(item.label, 300), context_text: asText(item.context_text, 500),
      selector: asText(item.selector, 500), data_button: asText(item.data_button, 120), target_url: asText(item.target_url, 2_000),
      product_name: asText(item.product_name, 160), product_type: asText(item.product_type, 40) || "in_person",
      status: asText(item.status, 30) || "upcoming", selectable: item.selectable === true,
    }));
  const datedTimes = new Set(options.flatMap((option) => {
    const text = `${option.schedule} ${option.context_text} ${option.label}`;
    const dated = /^\d{4}-\d{2}-\d{2}T/.test(option.schedule) || /\d{1,2}\s+(?:มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม)\s+\d{4}/.test(text);
    return dated ? (text.match(/\b\d{1,2}:\d{2}\b/g) || []) : [];
  }));
  const seen = new Set<string>();
  return options.filter((option) => {
    const text = `${option.schedule} ${option.context_text} ${option.label}`;
    const time = text.match(/\b\d{1,2}:\d{2}\b/)?.[0] || "";
    const dated = /^\d{4}-\d{2}-\d{2}T/.test(option.schedule) || /\d{1,2}\s+(?:มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม)\s+\d{4}/.test(text);
    if (!dated && time && datedTimes.has(time)) return false;
    const key = option.data_button ? `button:${option.data_button}` : option.target_url ? `url:${option.target_url}` : `${option.schedule}\u0000${option.context_text}\u0000${option.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return Boolean(option.schedule || option.context_text || option.label);
  });
}

function safeApiEvidence(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .slice(0, 50)
    .map((item) => ({
      method: asText(item.method, 12).toUpperCase(),
      url: asText(item.url, 2_000),
      resource_type: asText(item.resource_type, 30),
      status: typeof item.status === "number" ? item.status : null,
      content_type: asText(item.content_type, 200),
      response_content_type: asText(item.response_content_type, 200),
      same_origin: item.same_origin === true,
    }));
}

function parseSkillOutput(result: ToolExecutionResult): Record<string, unknown> {
  const stdout = asText(result.stdout, 20_000);
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* continue to an earlier line */ }
  }
  return {};
}

function publicInspectionFallback(url: string): string {
  const parsed = new URL(url);
  if (!new Set(["www.thaiticketmajor.com", "thaiticketmajor.com"]).has(parsed.hostname.toLowerCase())) return "";
  parsed.hostname = "booking.thaiticketmajor.com";
  if (["/", "/index.html"].includes(parsed.pathname)) parsed.pathname = "/index.php";
  return parsed.toString();
}

function inspectionBlocked(result: ToolExecutionResult): boolean {
  return result.access_blocked === true
    || /access\s*denied|permission\s+to\s+access|errors\.edgesuite\.net/i.test(`${asText(result.title, 500)} ${asText(result.content, 5_000)}`);
}

type TicketInspectionResult = ToolExecutionResult & { requested_url: string; inspection_url: string; used_public_fallback: boolean };

const inspectionFlights = new Map<string, { expires_at: number; promise: Promise<TicketInspectionResult> }>();

async function inspectPageOnce(url: string, settings: AppSettings, mode: "events" | "form"): Promise<TicketInspectionResult> {
  const inspectAction = mode === "events" ? "inspect_events" : "inspect_form";
  // Passive discovery owns one reusable background page. Opening a new page on
  // every click caused parallel navigations and avoidable CDN Access Denied.
  await executeTool("browser_action", { action: "open", url, fresh_page: false, public_inspection: true }, settings);
  let result = await executeTool("browser_action", { action: inspectAction, public_inspection: true }, settings);
  let inspectionUrl = url;
  let usedPublicFallback = false;
  if (inspectionBlocked(result)) {
    const fallback = publicInspectionFallback(url);
    if (!fallback || fallback === url) throw new Error(`หน้า public ถูกเว็บไซต์ปฏิเสธ (${asText(result.block_reason, 500) || "Access Denied"})`);
    assertInternetAndDomain(fallback, settings);
    await executeTool("browser_action", { action: "open", url: fallback, fresh_page: false, public_inspection: true }, settings);
    result = await executeTool("browser_action", { action: inspectAction, public_inspection: true }, settings);
    inspectionUrl = fallback;
    usedPublicFallback = true;
  }
  if (inspectionBlocked(result)) throw new Error(`ตรวจหน้าสาธารณะไม่ได้: ${asText(result.block_reason, 500) || "Access Denied"}`);
  return Object.assign({}, result, { requested_url: url, inspection_url: inspectionUrl, used_public_fallback: usedPublicFallback });
}

async function inspectPage(url: string, settings: AppSettings, mode: "events" | "form", forceRefresh = false): Promise<TicketInspectionResult> {
  const key = `${mode}:${url}`;
  if (forceRefresh) inspectionFlights.delete(key);
  const current = inspectionFlights.get(key);
  if (current && current.expires_at > Date.now()) return current.promise;

  const promise = inspectPageOnce(url, settings, mode);
  inspectionFlights.set(key, { expires_at: Date.now() + 15_000, promise });
  try {
    return await promise;
  } catch (error) {
    inspectionFlights.delete(key);
    throw error;
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { action?: unknown; url?: unknown; source_url?: unknown; event_id?: unknown; event_name?: unknown; input?: TicketBuildInput; discover_api?: unknown; run_id?: unknown; project_path?: unknown; username?: unknown; password?: unknown; value?: unknown; inspect_only?: unknown };
    const action = asText(body.action, 30) as TicketAction;
    const settings = await getSettings();

    // alpha-beta21-ticket-runtime-v1
    if (action === "run") {
      const projectPath = asText(body.project_path, 2_000);
      if (!projectPath) throw new Error("ไม่พบ project_path สำหรับเริ่ม Ticket Bot");
      const result = await startTicketRun({
        project_path: projectPath,
        username: asText(body.username, 500),
        password: typeof body.password === "string" ? body.password : "",
        inspect_only: body.inspect_only === true,
      });
      return Response.json(result);
    }
    if (action === "run_status") {
      const runId = asText(body.run_id, 200);
      if (!runId) throw new Error("ไม่พบ run_id");
      return Response.json(await getTicketRun(runId));
    }
    if (action === "run_input") {
      const runId = asText(body.run_id, 200);
      if (!runId) throw new Error("ไม่พบ run_id");
      return Response.json(await sendTicketRunInput(runId, typeof body.value === "string" ? body.value : ""));
    }
    if (action === "run_stop") {
      const runId = asText(body.run_id, 200);
      if (!runId) throw new Error("ไม่พบ run_id");
      return Response.json(await stopTicketRun(runId));
    }

    if (action === "inspect") {
      const url = publicHttpUrl(body.url);
      assertInternetAndDomain(url, settings);
      await executeTool("browser_action", { action: "reset_public_inspection", public_inspection: true }, settings);
      const inspected = await inspectPage(url, settings, "events", true);
      const listedEvents = normalizedEvents(inspected);
      const oldCache = await loadTicketScheduleCache(url);
      const cacheUpdates: TicketScheduleCacheRecord[] = [];
      let freshScheduleCount = 0;
      let cachedScheduleCount = 0;
      const events: TicketEvent[] = [];
      for (let eventIndex = 0; eventIndex < listedEvents.length; eventIndex += 1) {
        const event = listedEvents[eventIndex];
        if (!event.selectable || !["open", "upcoming"].includes(event.sale_status || "unknown")) {
          events.push(event);
          continue;
        }
        try {
          const detail = await inspectPage(event.url, settings, "form", true);
          const facts = detail.facts && typeof detail.facts === "object" && !Array.isArray(detail.facts) ? detail.facts as Record<string, unknown> : {};
          const showDates = Array.isArray(facts.show_dates) ? facts.show_dates.filter((item): item is { raw?: string; iso?: string } => Boolean(item && typeof item === "object")).slice(0, 30) : [];
          const performanceOptions = safePerformanceOptions(facts.performance_options).slice(0, 30);
          const checkedAt = Date.now();
          const detailSaleAt = Date.parse(asText(facts.sale_open_at, 200));
          const factsStatus = asText(facts.sale_status, 30) as TicketSaleStatus;
          const detailStatus: TicketSaleStatus = Number.isFinite(detailSaleAt) && detailSaleAt > Date.now()
            ? "upcoming"
            : new Set<TicketSaleStatus>(["open", "upcoming", "sold_out", "closed", "ended", "cancelled"]).has(factsStatus) ? factsStatus : event.sale_status || "unknown";
          const physicalOptions = performanceOptions.filter((option) => !option.product_type || option.product_type === "in_person");
          const physicalSoldOut = physicalOptions.length > 0 && physicalOptions.every((option) => ["sold_out", "closed"].includes(option.status));
          const enriched: TicketEvent = {
            ...event,
            show_dates: showDates,
            performance_options: performanceOptions,
            sale_open_at: asText(facts.sale_open_at, 200) || event.sale_open_at,
            sale_status: physicalSoldOut ? "sold_out" : detailStatus,
            selectable: !physicalSoldOut && ["open", "upcoming"].includes(detailStatus),
            inventory_status: physicalSoldOut ? "sold_out" : physicalOptions.some((option) => option.status === "open") ? "available" : "not_checked",
            inventory_evidence: physicalSoldOut ? "all_announced_in_person_performances_sold_out" : "announced_performance_rows_only",
            queue_open_at: asText(facts.queue_open_at, 200),
            schedule_checked_at: checkedAt,
            schedule_status: "fresh",
            cached_inspection: {
              page: { url: asText(detail.url, 2_000), title: asText(detail.title, 500), requested_url: event.url, inspection_url: asText(detail.inspection_url, 2_000), used_public_fallback: detail.used_public_fallback === true },
              candidates: detail.candidates && typeof detail.candidates === "object" ? detail.candidates : {},
              ambiguous_roles: Array.isArray(detail.ambiguous_roles) ? detail.ambiguous_roles : [],
              facts,
              functional_preflight: detail.functional_preflight && typeof detail.functional_preflight === "object" ? detail.functional_preflight : {},
              api_calls: [],
            },
          };
          events.push(enriched);
          freshScheduleCount += 1;
          cacheUpdates.push({
            source_url: url, event_id: event.id, event_name: event.name, event_url: event.url,
            show_dates: showDates,
            performance_options: performanceOptions.map(({ schedule, label, context_text, product_name, product_type, status, selectable }) => ({ schedule, label, context_text, product_name, product_type, status, selectable })),
            sale_open_at: enriched.sale_open_at || "", queue_open_at: enriched.queue_open_at || "", updated_at: checkedAt,
          });
        } catch {
          const cached = oldCache.get(event.id);
          if (!cached) {
            events.push({ ...event, schedule_status: "unavailable" });
          } else {
            cachedScheduleCount += 1;
            const cachedPerformanceOptions = safePerformanceOptions(cached.performance_options);
            const cachedPhysicalOptions = cachedPerformanceOptions.filter((option) => !option.product_type || option.product_type === "in_person");
            const cachedPhysicalSoldOut = cachedPhysicalOptions.length > 0 && cachedPhysicalOptions.every((option) => ["sold_out", "closed"].includes(option.status));
            const cachedSaleAt = Date.parse(cached.sale_open_at);
            const cachedStatus: TicketSaleStatus = cachedPhysicalSoldOut ? "sold_out"
              : Number.isFinite(cachedSaleAt) && cachedSaleAt > Date.now() ? "upcoming"
                : event.sale_status || "unknown";
            events.push({
              ...event,
              show_dates: cached.show_dates,
              performance_options: cachedPerformanceOptions,
              sale_open_at: cached.sale_open_at || event.sale_open_at,
              sale_status: cachedStatus,
              selectable: ["open", "upcoming"].includes(cachedStatus),
              inventory_status: cachedPhysicalSoldOut ? "sold_out" : cachedPhysicalOptions.some((option) => option.status === "open") ? "available" : "not_checked",
              inventory_evidence: cachedPhysicalSoldOut ? "all_cached_in_person_performances_sold_out" : "cached_announced_performance_rows_only",
              queue_open_at: cached.queue_open_at,
              schedule_checked_at: cached.updated_at,
              schedule_status: "cached",
              cached_inspection: {
                page: { requested_url: event.url, inspection_url: event.url }, candidates: {}, ambiguous_roles: [], api_calls: [],
                facts: { event_name: event.name, event_url: event.url, show_dates: cached.show_dates, performance_options: cachedPerformanceOptions, sale_open_at: cached.sale_open_at, queue_open_at: cached.queue_open_at, sale_status: cachedStatus, evidence: [{ field: "schedule_cache", text: "cached announced dates", source: "ticket_event_schedule_cache" }] },
                functional_preflight: { public_page_verified: false, runtime_discovery_required: true, can_build: ["open", "upcoming"].includes(cachedStatus), workflow_state: cachedStatus === "upcoming" ? "pre_sale" : cachedStatus === "sold_out" ? "sold_out" : "runtime_discovery" },
              },
            });
          }
        }
        // Inspecting every detail page in one tight burst causes the public
        // CDN to reject otherwise normal browser navigation. Keep one page and
        // a modest human-scale interval; this pass runs only when Discover is
        // explicitly pressed and the announced schedules are cached.
        if (eventIndex < listedEvents.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 900));
        }
      }
      await saveTicketScheduleCache(cacheUpdates);
      const counts = events.reduce((result, event) => {
        const status = event.sale_status || "unknown";
        result[status] = (result[status] || 0) + 1;
        return result;
      }, {} as Record<string, number>);
      const unavailableCount = events.filter((event) => event.selectable === false).length;
      const inventoryCheckedCount = events.filter((event) => ["available", "sold_out"].includes(event.inventory_status || "not_checked")).length;
      const fallbackNote = inspected.used_public_fallback === true ? " · ใช้หน้ารวม official สำรองเพราะหน้าแรกตอบ Access Denied" : "";
      return Response.json({
        ok: true,
        stage: "events_inspected",
        page: { url: asText(inspected.url, 2_000), title: asText(inspected.title, 500), requested_url: url, inspection_url: asText(inspected.inspection_url, 2_000), used_public_fallback: inspected.used_public_fallback === true },
        events,
        counts,
        excluded_count: unavailableCount,
        inventory: { scope: "listing_only", checked_count: inventoryCheckedCount, requires_login_for_live_stock: true },
        schedule_cache: { fresh_count: freshScheduleCount, cached_fallback_count: cachedScheduleCount, inventory_stored: false },
        message: events.length ? `ตรวจวันแสดงใหม่ ${freshScheduleCount} งาน · ใช้ข้อมูลเดิมเพราะเว็บปฏิเสธชั่วคราว ${cachedScheduleCount} งาน · เปิดช่วงขาย ${counts.open || 0} · กำลังจะเปิด ${counts.upcoming || 0} · พบป้าย SOLD OUT ${counts.sold_out || 0} · ปิดขาย ${counts.closed || 0} · งานจบแล้ว ${counts.ended || 0} · ยกเลิก ${counts.cancelled || 0} · ยังยืนยันไม่ได้ ${counts.unknown || 0} · ไม่เก็บจำนวนบัตรหรือสถานะที่นั่ง${fallbackNote}` : `ไม่พบรายการคอนเสิร์ตจากหน้านี้${fallbackNote}`,
      });
    }

    if (action === "inspect_form") {
      const url = publicHttpUrl(body.url);
      assertInternetAndDomain(url, settings);
      let inspected: TicketInspectionResult | null = null;
      let inspectionWarning = "";
      try {
        // A selected event is one explicit browser navigation. Give it a clean
        // isolated profile instead of reusing a listing scan that the CDN may
        // already have rejected.
        await executeTool("browser_action", { action: "reset_public_inspection", public_inspection: true }, settings);
        inspected = await inspectPage(url, settings, "form", true);
      } catch (error) {
        inspectionWarning = error instanceof Error ? error.message : "หน้าเว็บไม่อนุญาตให้ตรวจแบบ passive";
      }
      if (!inspected) {
        return Response.json({
          ok: true,
          stage: "runtime_discovery_required",
          page: { requested_url: url, inspection_url: url, used_public_fallback: false },
          controls: [],
          candidates: {},
          ambiguous_roles: [],
          facts: {
            event_url: url,
            sale_status: "unknown",
            evidence: [{ field: "inspection", text: inspectionWarning, source: "public_inspection" }],
          },
          functional_preflight: {
            passed: false,
            public_page_verified: false,
            purchase_controls_ready: false,
            workflow_state: "runtime_discovery",
            unresolved: ["schedule", "sale_open_at", "form_controls"],
            can_build: true,
            can_run_live_selection: false,
            runtime_discovery_required: true,
            inspection_warning: inspectionWarning,
          },
          api_calls: [],
          api_warning: inspectionWarning,
        });
      }
      let apiCalls: Array<Record<string, unknown>> = [];
      let apiWarning = "";
      if (body.discover_api === true && settings.browser_mode === "alpha") {
        try {
          const discovered = await executeTool("api_discovery", { action: "discover", url, observe_seconds: 3, public_inspection: true }, settings);
          apiCalls = safeApiEvidence(discovered.api_calls);
        } catch (error) {
          apiWarning = error instanceof Error ? error.message : "ตรวจ API แบบ passive ไม่สำเร็จ";
        }
      }
      const inspectedFacts = inspected.facts && typeof inspected.facts === "object" && !Array.isArray(inspected.facts)
        ? inspected.facts as Record<string, unknown>
        : {};
      const sourceUrl = typeof body.source_url === "string" && body.source_url.trim() ? publicHttpUrl(body.source_url) : "";
      const eventId = asText(body.event_id, 2_000);
      if (sourceUrl && eventId) {
        await saveTicketScheduleCache([{
          source_url: sourceUrl,
          event_id: eventId,
          event_name: asText(body.event_name, 500) || asText(inspectedFacts.event_name, 500),
          event_url: url,
          show_dates: Array.isArray(inspectedFacts.show_dates) ? inspectedFacts.show_dates.filter((item): item is { raw?: string; iso?: string } => Boolean(item && typeof item === "object")).slice(0, 30) : [],
          performance_options: safePerformanceOptions(inspectedFacts.performance_options).map(({ schedule, label, context_text, product_name, product_type, status, selectable }) => ({ schedule, label, context_text, product_name, product_type, status, selectable })),
          sale_open_at: asText(inspectedFacts.sale_open_at, 200),
          queue_open_at: asText(inspectedFacts.queue_open_at, 200),
          updated_at: Date.now(),
        }]);
      }
      return Response.json({
        ok: true,
        stage: "form_inspected",
        page: { url: asText(inspected.url, 2_000), title: asText(inspected.title, 500), requested_url: url, inspection_url: asText(inspected.inspection_url, 2_000), used_public_fallback: inspected.used_public_fallback === true },
        controls: Array.isArray(inspected.controls) ? inspected.controls.slice(0, 300) : [],
        candidates: inspected.candidates && typeof inspected.candidates === "object" ? inspected.candidates : {},
        ambiguous_roles: Array.isArray(inspected.ambiguous_roles) ? inspected.ambiguous_roles.slice(0, 30) : [],
        facts: inspectedFacts,
        functional_preflight: inspected.functional_preflight && typeof inspected.functional_preflight === "object" ? inspected.functional_preflight : {},
        api_calls: apiCalls,
        api_warning: apiWarning,
      });
    }

    if (action === "build") {
      const input = body.input ?? {};
      const eventUrl = publicHttpUrl(input.event_url);
      assertInternetAndDomain(eventUrl, settings);
      const candidates = safeCandidates(input.event_candidates);
      const selectedId = asText(input.selected_event_id, 500);
      const selected = candidates.find((event) => event.id === selectedId);
      if (!selected) throw new Error("กรุณาเลือกคอนเสิร์ตจากรายการที่ตรวจพบก่อนสร้างบอท");
      if (selected.url !== eventUrl) throw new Error("URL ของคอนเสิร์ตไม่ตรงกับรายการที่เลือก กรุณาตรวจหน้าเว็บใหม่");
      assertInternetAndDomain(selected.url, settings);
      const suppliedFacts = input.event_facts && typeof input.event_facts === "object" && !Array.isArray(input.event_facts)
        ? input.event_facts as Record<string, unknown> : null;
      const suppliedPreflight = input.functional_preflight && typeof input.functional_preflight === "object" && !Array.isArray(input.functional_preflight)
        ? input.functional_preflight as Record<string, unknown> : null;
      const suppliedEventUrl = suppliedFacts ? asText(suppliedFacts.event_url, 2_000) : "";
      const hasCachedScheduleEvidence = Boolean(suppliedFacts
        && (!suppliedEventUrl || suppliedEventUrl === selected.url)
        && ((Array.isArray(suppliedFacts.performance_options) && suppliedFacts.performance_options.length)
          || (Array.isArray(suppliedFacts.show_dates) && suppliedFacts.show_dates.length)));
      let eventFacts: Record<string, unknown> = hasCachedScheduleEvidence ? suppliedFacts! : {
        event_name: selected.name,
        event_url: selected.url,
        show_dates: selected.start_date ? [{ raw: selected.start_date }] : [],
        sale_open_at: selected.sale_open_at,
        sale_status: selected.sale_status,
        evidence: [{ field: "sale_status", text: selected.sale_status, source: "public_listing" }],
      };
      let functionalPreflight: Record<string, unknown> = hasCachedScheduleEvidence && suppliedPreflight ? suppliedPreflight : {};
      let inspectionWarning = "";
      if (!hasCachedScheduleEvidence) {
        try {
          const liveInspection = await inspectPage(selected.url, settings, "form");
          if (liveInspection.facts && typeof liveInspection.facts === "object" && !Array.isArray(liveInspection.facts)) eventFacts = liveInspection.facts as Record<string, unknown>;
          if (liveInspection.functional_preflight && typeof liveInspection.functional_preflight === "object" && !Array.isArray(liveInspection.functional_preflight)) functionalPreflight = liveInspection.functional_preflight as Record<string, unknown>;
        } catch (error) {
          inspectionWarning = error instanceof Error ? error.message : "ตรวจหน้ารายละเอียดไม่ได้";
        }
      }
      if (functionalPreflight.public_page_verified !== true) {
        const unresolved = Array.isArray(functionalPreflight.unresolved)
          ? functionalPreflight.unresolved.map((item) => asText(item, 80)).filter(Boolean)
          : ["schedule", "sale_open_at", "form_controls"];
        functionalPreflight = {
          ...functionalPreflight,
          passed: false,
          public_page_verified: false,
          purchase_controls_ready: false,
          workflow_state: "runtime_discovery",
          unresolved,
          can_build: true,
          can_run_live_selection: false,
          runtime_discovery_required: true,
          inspection_warning: inspectionWarning,
        };
      }
      if (functionalPreflight.can_build !== true) throw new Error("คอนเสิร์ตนี้ไม่อยู่ในสถานะที่สร้าง workflow ต่อได้");
      const seatMode = asText(input.seat_mode, 30);
      if (!new Set(["reserved", "standing", "general_admission"]).has(seatMode)) throw new Error("กรุณาเลือกประเภทบัตร");
      const seatGrouping = asText(input.seat_grouping, 30) || "adjacent";
      if (seatMode === "reserved" && !new Set(["adjacent", "same_zone", "any"]).has(seatGrouping)) throw new Error("กรุณาเลือกว่าจะเอาที่นั่งติดกัน คละในโซน หรือใบไหนก็ได้");
      const seatFallbackMode = asText(input.seat_fallback_mode, 30) || "nearest";
      if (seatMode === "reserved" && !new Set(["exact", "nearest", "zone_any"]).has(seatFallbackMode)) throw new Error("กรุณาเลือกวิธีสำรองเมื่อที่นั่งเป้าหมายไม่ว่าง");
      const paymentMethod = asText(input.payment_method, 30).toLowerCase();
      if (!new Set(["qr", "promptpay"]).has(paymentMethod)) throw new Error("รองรับวิธีชำระเงิน QR หรือ PromptPay ใน Full Loop นี้");
      const quantity = Math.min(10, Math.max(1, Math.floor(Number(input.quantity || 1))));
      const budget = Math.max(0, Number(input.budget || 0));
      const selectedPerformance = safeSelectedPerformance(input.selected_performance);
      const announcedPerformances = Array.isArray(eventFacts.performance_options) ? eventFacts.performance_options : [];
      if (announcedPerformances.length > 1 && !selectedPerformance) throw new Error("คอนเสิร์ตนี้มีหลายวัน กรุณาเลือกรอบก่อนเริ่มบอท เพื่อไม่ให้เลือกรอบผิดหลังผ่านคิว");
      if (selectedPerformance && ["sold_out", "closed"].includes(selectedPerformance.status)) throw new Error("รอบที่เลือกขายหมดหรือปิดขายแล้ว จึงไม่เริ่มบอทซื้อบัตร");
      if (selectedPerformance?.target_url) {
        const performanceUrl = publicHttpUrl(selectedPerformance.target_url);
        assertInternetAndDomain(performanceUrl, settings);
        selectedPerformance.target_url = performanceUrl;
      }
      const address = input.shipping_address && typeof input.shipping_address === "object" && !Array.isArray(input.shipping_address)
        ? Object.fromEntries(Object.entries(input.shipping_address as Record<string, unknown>).filter(([key, value]) => /^[a-zA-Z0-9_.-]{1,60}$/.test(key) && typeof value === "string" && value.trim()).slice(0, 20).map(([key, value]) => [key, String(value).trim().slice(0, 500)]))
        : {};
      const skillSettings: AppSettings = { ...settings, file_access_mode: "full_user_files" };
      const skillResult = await executeTool("run_learned_skill", {
        skill_id: "concert-ticket-purchase-assistant",
        execution_target: "macos_host",
        input: {
          event_url: selected.url,
          event_candidates: candidates,
          selected_event_id: selected.id,
          selected_event_name: selected.name,
          quantity,
          budget,
          schedule: asText(input.schedule, 200)
            || asText((Array.isArray(eventFacts.show_dates) ? (eventFacts.show_dates[0] as Record<string, unknown> | undefined)?.iso : ""), 200)
            || asText((Array.isArray(eventFacts.show_dates) ? (eventFacts.show_dates[0] as Record<string, unknown> | undefined)?.raw : ""), 200),
          selected_performance: selectedPerformance,
          sale_open_at: asText(eventFacts.sale_open_at, 200),
          queue_open_at: asText(input.queue_open_at, 200),
          seat_mode: seatMode,
          seat_grouping: seatGrouping,
          preferred_zones: Array.isArray(input.preferred_zones) ? input.preferred_zones.map((item) => asText(item, 120).toUpperCase()).filter(Boolean).slice(0, 20) : [],
          preferred_rows: Array.isArray(input.preferred_rows) ? input.preferred_rows.map((item) => asText(item, 30).toUpperCase()).filter(Boolean).slice(0, 50) : [],
          preferred_seat_numbers: Array.isArray(input.preferred_seat_numbers) ? input.preferred_seat_numbers.map((item) => asText(item, 30).toUpperCase()).filter(Boolean).slice(0, 100) : [],
          seat_fallback_mode: seatFallbackMode,
          customer_name: asText(input.customer_name, 200),
          attendee_names: Array.isArray(input.attendee_names) ? input.attendee_names.map((item) => asText(item, 200)).filter(Boolean).slice(0, quantity) : [],
          shipping_address: address,
          delivery_method: new Set(["pickup", "postal"]).has(asText(input.delivery_method, 30)) ? asText(input.delivery_method, 30) : "pickup",
          ticket_protect: input.ticket_protect === true,
          payment_method: paymentMethod,
          selectors: safeSelectors(input.selectors),
          captured_api: safeApiEvidence(input.captured_api),
          event_facts: eventFacts,
          functional_preflight: functionalPreflight,
          project_name: asText(input.project_name, 80),
          page_state: "preferences",
          queue_state: "not_started",
          retry_after_seconds: 1,
        },
      }, skillSettings);
      if (!skillResult.ok) throw new Error(asText(skillResult.stderr, 2_000) || "สกิลสร้างโปรเจกต์ไม่สำเร็จ");
      const output = parseSkillOutput(skillResult);
      const createdFiles = Array.isArray(output.created_files) ? output.created_files.map((item) => asText(item, 200)).filter(Boolean) : [];
      const projectPath = asText(output.created_project_path, 2_000);
      const expectedFiles = ["bot.py", "state_machine.py", "tests/test_state_machine.py", "config.json", "requirements.txt", "start.command", "run-full-loop.command", "README.md", "verification-report.json"];
      const structuralPass = Boolean(projectPath && expectedFiles.every((file) => createdFiles.includes(file)));
      const fixtureVerification = output.fixture_verification && typeof output.fixture_verification === "object" && !Array.isArray(output.fixture_verification)
        ? output.fixture_verification as Record<string, unknown>
        : {};
      const fixturePass = fixtureVerification.fixture_tests_passed === true && fixtureVerification.queue_fixture_verified === true;
      const verified = structuralPass && fixturePass && output.status === "project_verified";
      return Response.json({
        ok: verified,
        stage: verified ? "project_fixture_verified" : structuralPass ? "project_unverified" : "project_incomplete",
        generator_version: asText(output.generator_version, 80),
        output,
        project_path: projectPath,
        created_files: createdFiles,
        verification: {
          structure_passed: structuralPass,
          fixture_tests_passed: fixturePass,
          queue_fixture_verified: fixtureVerification.queue_fixture_verified === true,
          live_public_page_verified: functionalPreflight.public_page_verified === true,
          runtime_discovery_required: functionalPreflight.runtime_discovery_required === true,
          inspection_warning: asText(functionalPreflight.inspection_warning, 1_000),
          live_queue_observed: false,
          live_checkout_verified: false,
          workflow_state: asText(functionalPreflight.workflow_state, 80),
          purchase_controls_ready: functionalPreflight.purchase_controls_ready === true,
          expected_files: expectedFiles,
          found_files: createdFiles,
          live_purchase_attempted: false,
          handoff_points: ["captcha", "otp", "payment"],
        },
        live_facts: eventFacts,
        functional_preflight: functionalPreflight,
        artifacts: Array.isArray(skillResult.artifacts) ? skillResult.artifacts : [],
      }, { status: verified ? 200 : 422 });
    }

    return Response.json({ error: "ไม่รู้จัก action ของ Ticket Bot" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Ticket Bot Full Loop ไม่สำเร็จ" }, { status: 500 });
  }
}
