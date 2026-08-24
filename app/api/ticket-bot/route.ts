import { domainAllowed } from "@/lib/policy.js";
import { getSettings } from "@/lib/settings-store";
import { executeTool, ToolExecutionResult } from "@/lib/tool-client";
import { AppSettings } from "@/lib/types";

type TicketAction = "inspect" | "inspect_form" | "build";

interface TicketEvent {
  id: string;
  name: string;
  url: string;
  start_date?: string;
  end_date?: string;
  sale_open_at?: string;
  sale_status?: "open" | "upcoming";
  source?: string;
}

interface TicketBuildInput {
  event_url?: unknown;
  event_candidates?: unknown;
  selected_event_id?: unknown;
  selected_event_name?: unknown;
  schedule?: unknown;
  sale_open_at?: unknown;
  queue_open_at?: unknown;
  seat_mode?: unknown;
  seat_grouping?: unknown;
  preferred_zones?: unknown;
  quantity?: unknown;
  budget?: unknown;
  customer_name?: unknown;
  shipping_address?: unknown;
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

function normalizedEvents(result: ToolExecutionResult): TicketEvent[] {
  if (!Array.isArray(result.events)) return [];
  return result.events.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const id = asText(record.id, 500);
    const name = asText(record.name, 500);
    const url = asText(record.url, 2_000);
    const status = asText(record.sale_status, 30);
    if (!id || !name || !url || !["open", "upcoming"].includes(status)) return [];
    return [{
      id,
      name,
      url,
      start_date: asText(record.start_date, 100),
      end_date: asText(record.end_date, 100),
      sale_open_at: asText(record.sale_open_at, 100),
      sale_status: status as "open" | "upcoming",
      source: asText(record.source, 50),
    }];
  }).slice(0, 100);
}

function safeCandidates(value: unknown): TicketEvent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const id = asText(record.id, 500);
    const name = asText(record.name, 500);
    const url = asText(record.url, 2_000);
    const status = asText(record.sale_status, 30);
    if (!id || !name || !url || !["open", "upcoming"].includes(status)) return [];
    return [{
      id, name, url,
      start_date: asText(record.start_date, 100),
      end_date: asText(record.end_date, 100),
      sale_open_at: asText(record.sale_open_at, 100),
      sale_status: status as "open" | "upcoming",
      source: asText(record.source, 50),
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

async function inspectPage(url: string, settings: AppSettings, mode: "events" | "form") {
  await executeTool("browser_action", { action: "open", url }, settings);
  return executeTool("browser_action", { action: mode === "events" ? "inspect_events" : "inspect_form" }, settings);
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { action?: unknown; url?: unknown; input?: TicketBuildInput; discover_api?: unknown };
    const action = asText(body.action, 30) as TicketAction;
    const settings = await getSettings();

    if (action === "inspect") {
      const url = publicHttpUrl(body.url);
      assertInternetAndDomain(url, settings);
      const inspected = await inspectPage(url, settings, "events");
      const events = normalizedEvents(inspected);
      return Response.json({
        ok: true,
        stage: "events_inspected",
        page: { url: asText(inspected.url, 2_000), title: asText(inspected.title, 500) },
        events,
        excluded_count: Number(inspected.excluded_count || 0),
        message: events.length ? `พบคอนเสิร์ตที่เปิดขายหรือกำลังจะเปิด ${events.length} รายการ` : "ไม่พบคอนเสิร์ตที่เปิดขายหรือกำลังจะเปิดจากหน้านี้",
      });
    }

    if (action === "inspect_form") {
      const url = publicHttpUrl(body.url);
      assertInternetAndDomain(url, settings);
      const inspected = await inspectPage(url, settings, "form");
      let apiCalls: Array<Record<string, unknown>> = [];
      let apiWarning = "";
      if (body.discover_api === true && settings.browser_mode === "alpha") {
        try {
          const discovered = await executeTool("api_discovery", { action: "discover", url, observe_seconds: 3 }, settings);
          apiCalls = safeApiEvidence(discovered.api_calls);
        } catch (error) {
          apiWarning = error instanceof Error ? error.message : "ตรวจ API แบบ passive ไม่สำเร็จ";
        }
      }
      return Response.json({
        ok: true,
        stage: "form_inspected",
        page: { url: asText(inspected.url, 2_000), title: asText(inspected.title, 500) },
        controls: Array.isArray(inspected.controls) ? inspected.controls.slice(0, 300) : [],
        candidates: inspected.candidates && typeof inspected.candidates === "object" ? inspected.candidates : {},
        ambiguous_roles: Array.isArray(inspected.ambiguous_roles) ? inspected.ambiguous_roles.slice(0, 30) : [],
        facts: inspected.facts && typeof inspected.facts === "object" ? inspected.facts : {},
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
      const liveInspection = await inspectPage(selected.url, settings, "form");
      const eventFacts = liveInspection.facts && typeof liveInspection.facts === "object" && !Array.isArray(liveInspection.facts)
        ? liveInspection.facts as Record<string, unknown>
        : {};
      const functionalPreflight = liveInspection.functional_preflight && typeof liveInspection.functional_preflight === "object" && !Array.isArray(liveInspection.functional_preflight)
        ? liveInspection.functional_preflight as Record<string, unknown>
        : {};
      if (functionalPreflight.public_page_verified !== true) {
        const unresolved = Array.isArray(functionalPreflight.unresolved) ? functionalPreflight.unresolved.map((item) => asText(item, 80)).filter(Boolean) : [];
        throw new Error(`หลักฐานหน้าคอนเสิร์ตยังไม่ครบ${unresolved.length ? `: ${unresolved.join(", ")}` : ""} — ยังไม่สร้างโปรเจกต์เพื่อป้องกันผลผ่านปลอม`);
      }
      if (functionalPreflight.can_build !== true) throw new Error("คอนเสิร์ตนี้ไม่อยู่ในสถานะที่สร้าง workflow ต่อได้");
      const seatMode = asText(input.seat_mode, 30);
      if (!new Set(["reserved", "standing", "general_admission"]).has(seatMode)) throw new Error("กรุณาเลือกประเภทบัตร");
      const seatGrouping = asText(input.seat_grouping, 30) || "adjacent";
      if (seatMode === "reserved" && !new Set(["adjacent", "same_zone", "any"]).has(seatGrouping)) throw new Error("กรุณาเลือกว่าจะเอาที่นั่งติดกัน คละในโซน หรือใบไหนก็ได้");
      const paymentMethod = asText(input.payment_method, 30).toLowerCase();
      if (!new Set(["qr", "promptpay"]).has(paymentMethod)) throw new Error("รองรับวิธีชำระเงิน QR หรือ PromptPay ใน Full Loop นี้");
      const quantity = Math.min(10, Math.max(1, Math.floor(Number(input.quantity || 1))));
      const budget = Math.max(0, Number(input.budget || 0));
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
          sale_open_at: asText(eventFacts.sale_open_at, 200),
          queue_open_at: asText(input.queue_open_at, 200),
          seat_mode: seatMode,
          seat_grouping: seatGrouping,
          preferred_zones: Array.isArray(input.preferred_zones) ? input.preferred_zones.map((item) => asText(item, 120).toUpperCase()).filter(Boolean).slice(0, 20) : [],
          customer_name: asText(input.customer_name, 200),
          shipping_address: address,
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
      const expectedFiles = ["bot.py", "state_machine.py", "tests/test_state_machine.py", "config.json", "requirements.txt", "start.command", "README.md", "verification-report.json"];
      const structuralPass = Boolean(projectPath && expectedFiles.every((file) => createdFiles.includes(file)));
      const fixtureVerification = output.fixture_verification && typeof output.fixture_verification === "object" && !Array.isArray(output.fixture_verification)
        ? output.fixture_verification as Record<string, unknown>
        : {};
      const fixturePass = fixtureVerification.fixture_tests_passed === true && fixtureVerification.queue_fixture_verified === true;
      const verified = structuralPass && fixturePass && output.status === "project_verified";
      return Response.json({
        ok: verified,
        stage: verified ? "project_fixture_verified" : structuralPass ? "project_unverified" : "project_incomplete",
        output,
        project_path: projectPath,
        created_files: createdFiles,
        verification: {
          structure_passed: structuralPass,
          fixture_tests_passed: fixturePass,
          queue_fixture_verified: fixtureVerification.queue_fixture_verified === true,
          live_public_page_verified: functionalPreflight.public_page_verified === true,
          live_queue_observed: false,
          live_checkout_verified: false,
          workflow_state: asText(functionalPreflight.workflow_state, 80),
          purchase_controls_ready: functionalPreflight.purchase_controls_ready === true,
          expected_files: expectedFiles,
          found_files: createdFiles,
          live_purchase_attempted: false,
          handoff_points: ["login", "captcha", "otp", "payment"],
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
