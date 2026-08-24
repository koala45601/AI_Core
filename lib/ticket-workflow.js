const THAI_MONTHS = new Map([
  ["มกราคม", 1], ["ม.ค.", 1], ["ม.ค", 1],
  ["กุมภาพันธ์", 2], ["ก.พ.", 2], ["ก.พ", 2],
  ["มีนาคม", 3], ["มี.ค.", 3], ["มี.ค", 3],
  ["เมษายน", 4], ["เม.ย.", 4], ["เม.ย", 4],
  ["พฤษภาคม", 5], ["พ.ค.", 5], ["พ.ค", 5],
  ["มิถุนายน", 6], ["มิ.ย.", 6], ["มิ.ย", 6],
  ["กรกฎาคม", 7], ["ก.ค.", 7], ["ก.ค", 7],
  ["สิงหาคม", 8], ["ส.ค.", 8], ["ส.ค", 8],
  ["กันยายน", 9], ["ก.ย.", 9], ["ก.ย", 9],
  ["ตุลาคม", 10], ["ต.ค.", 10], ["ต.ค", 10],
  ["พฤศจิกายน", 11], ["พ.ย.", 11], ["พ.ย", 11],
  ["ธันวาคม", 12], ["ธ.ค.", 12], ["ธ.ค", 12],
]);

const MONTH_PATTERN = [...THAI_MONTHS.keys()]
  .sort((left, right) => right.length - left.length)
  .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

export function normalizeTicketText(value) {
  return String(value || "").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\r/g, "").trim();
}

export function parseThaiDateTime(value) {
  const text = normalizeTicketText(value);
  if (!text) return { raw: "", iso: "" };
  const direct = Date.parse(text);
  if (Number.isFinite(direct) && /\d{4}-\d{2}-\d{2}/.test(text)) {
    return { raw: text, iso: new Date(direct).toISOString() };
  }
  const match = text.match(new RegExp(`(\\d{1,2})\\s+(${MONTH_PATTERN})\\s+(\\d{4})(?:[^\\d]{0,20}(\\d{1,2})[:.]?(\\d{2}))?`, "i"));
  if (!match) return { raw: text, iso: "" };
  const month = THAI_MONTHS.get(match[2]) || 0;
  let year = Number(match[3]);
  if (year >= 2400) year -= 543;
  const day = Number(match[1]);
  const hour = Number(match[4] || 0);
  const minute = Number(match[5] || 0);
  if (!month || year < 2000 || year > 2200 || day < 1 || day > 31 || hour > 23 || minute > 59) return { raw: text, iso: "" };
  const pad = (number) => String(number).padStart(2, "0");
  return { raw: text, iso: `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00+07:00` };
}

function firstLabelValue(text, labels, maxLength = 300) {
  const lines = normalizeTicketText(text).split("\n").map((line) => line.trim()).filter(Boolean);
  const labelPattern = new RegExp(`(?:${labels.join("|")})`, "i");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!labelPattern.test(line)) continue;
    const inline = line.replace(labelPattern, "").replace(/^\s*[:：-]\s*/, "").trim();
    if (inline) return inline.slice(0, maxLength);
    if (lines[index + 1]) return lines[index + 1].slice(0, maxLength);
  }
  return "";
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function discoveredSeatValues(snapshot, controls) {
  const zones = Array.isArray(snapshot.discovered_zones) ? snapshot.discovered_zones : [];
  const rows = Array.isArray(snapshot.discovered_rows) ? snapshot.discovered_rows : [];
  for (const control of Array.isArray(controls) ? controls : []) {
    if (control?.semantic_role !== "seat_or_zone") continue;
    for (const option of Array.isArray(control.options) ? control.options : []) {
      const value = normalizeTicketText(option?.text || option?.value || "");
      if (value && !/เลือก|select|ทั้งหมด|all/i.test(value)) zones.push(value);
    }
  }
  return {
    zones: unique(zones.map((value) => normalizeTicketText(value).toUpperCase()).filter((value) => value.length <= 80)).slice(0, 100),
    rows: unique(rows.map((value) => normalizeTicketText(value).toUpperCase()).filter((value) => value.length <= 30)).slice(0, 200),
  };
}

function pricesFromText(text) {
  const priceLine = firstLabelValue(text, ["ราคาบัตร", "ticket\\s*price", "price"], 500);
  const source = priceLine || normalizeTicketText(text).slice(0, 30_000);
  const matches = source.match(/\b\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?\b|\b\d{3,6}(?:\.\d{1,2})?\s*(?:บาท|baht|thb)\b/gi) || [];
  return unique(matches.map((item) => Number(item.replace(/[^\d.]/g, ""))).filter((item) => Number.isFinite(item) && item >= 100 && item <= 1_000_000)).sort((a, b) => b - a);
}

function semanticSaleEntryControls(controls) {
  const mapped = (Array.isArray(controls) ? controls : []).filter((control) => {
    if (!control || typeof control !== "object" || control.disabled === true) return false;
    const text = `${control.semantic_role || ""} ${control.label || ""} ${control.aria_label || ""} ${control.name || ""}`.toLowerCase();
    if (/order\s*history|purchase\s*history|ประวัติการสั่งซื้อ/.test(text)) return false;
    return control.semantic_role === "purchase_action"
      || control.semantic_role === "schedule"
      || /buy\s*now|book\s*now|purchase|checkout|ซื้อบัตร|จองบัตร|เลือกรอบ/.test(text);
  }).map((control) => ({
    selector: String(control.selector || ""),
    label: String(control.label || control.aria_label || "").slice(0, 200),
    context_text: String(control.context_text || "").slice(0, 300),
    semantic_role: String(control.semantic_role || "purchase_action"),
    selector_confidence: Number(control.selector_confidence || 0),
  }));
  const seen = new Set();
  return mapped.filter((control) => {
    const key = `${control.semantic_role}\u0000${control.label}\u0000${control.context_text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function extractTicketPageFacts(snapshot = {}) {
  const bodyText = normalizeTicketText(snapshot.body_text || snapshot.bodyText || "");
  const structured = Array.isArray(snapshot.structured_events) ? snapshot.structured_events : [];
  const firstStructured = structured.find((item) => item && typeof item === "object") || {};
  const showRaw = firstLabelValue(bodyText, ["วันที่แสดง", "วันแสดง", "show\\s*date", "event\\s*date"])
    || String(firstStructured.start_date || firstStructured.startDate || "");
  const saleRaw = firstLabelValue(bodyText, ["วันเปิดจำหน่าย", "วันเปิดขาย", "เปิดจำหน่าย", "เปิดขาย", "on\\s*sale"])
    || String(firstStructured.sale_open_at || firstStructured.validFrom || "");
  const explicitStatus = firstLabelValue(bodyText, ["ticket\\s*status", "สถานะบัตร", "สถานะการจำหน่าย"], 120).toLowerCase();
  const venue = firstLabelValue(bodyText, ["สถานที่แสดง", "สถานที่", "venue", "location"]);
  const showDate = parseThaiDateTime(showRaw);
  const saleDate = parseThaiDateTime(saleRaw);
  const combined = `${bodyText}\n${String(snapshot.title || "")}`.toLowerCase();
  const explicitClosed = /sold\s*out|sale\s*ended|closed|cancelled|canceled|ปิดขาย|ขายหมด|ยกเลิก|สิ้นสุดแล้ว/.test(explicitStatus);
  const explicitUpcoming = /coming\s*soon|เตรียมเปิดขาย|กำลังจะเปิด|เร็ว\s*ๆ\s*นี้/.test(explicitStatus);
  const explicitOpen = /on\s*sale|available|buy\s*now|เปิดขาย|จำหน่ายแล้ว/.test(explicitStatus);
  const isClosed = explicitStatus ? explicitClosed : /sold\s*out|sale\s*ended|closed|cancelled|canceled|ปิดขาย|ขายหมด|ยกเลิก|สิ้นสุดแล้ว/.test(combined);
  const isUpcoming = explicitUpcoming || (!explicitStatus && (
    /coming\s*soon|เตรียมเปิดขาย|กำลังจะเปิด|เร็ว\s*ๆ\s*นี้/.test(combined)
    || (saleDate.iso && Date.parse(saleDate.iso) > Date.now())
  ));
  const rawEntryControls = semanticSaleEntryControls(snapshot.controls);
  const purchaseControls = rawEntryControls.filter((control) => control.semantic_role === "purchase_action");
  const rawPerformanceOptions = rawEntryControls.filter((control) => control.semantic_role === "schedule");
  const timedPerformanceOptions = rawPerformanceOptions.filter((control) => /^\s*\d{1,2}:\d{2}/.test(control.label));
  const performanceOptions = timedPerformanceOptions.length ? timedPerformanceOptions : rawPerformanceOptions;
  const saleEntryControls = [...performanceOptions, ...purchaseControls];
  const saleStatus = isClosed ? "closed" : isUpcoming ? "upcoming" : explicitOpen || saleEntryControls.length ? "open" : "unknown";
  const discoveredSeats = discoveredSeatValues(snapshot, snapshot.controls);
  const evidence = [];
  if (showRaw) evidence.push({ field: "show_date", text: showRaw.slice(0, 300), source: "page_text" });
  if (saleRaw) evidence.push({ field: "sale_open_at", text: saleRaw.slice(0, 300), source: "page_text" });
  if (venue) evidence.push({ field: "venue", text: venue.slice(0, 300), source: "page_text" });
  if (saleStatus !== "unknown") evidence.push({ field: "sale_status", text: saleStatus, source: "page_state" });
  for (const control of saleEntryControls.slice(0, 8)) evidence.push({ field: control.semantic_role === "schedule" ? "performance_option" : "purchase_control", text: control.label || control.selector, source: "dom_control" });
  return {
    event_name: String(snapshot.title || firstStructured.name || "").trim().slice(0, 500),
    event_url: String(snapshot.url || "").slice(0, 2_000),
    show_dates: showRaw ? [{ raw: showDate.raw, iso: showDate.iso }] : [],
    sale_open_at: saleDate.iso,
    sale_open_at_raw: saleDate.raw,
    sale_status: saleStatus,
    ticket_status: isClosed ? "closed" : isUpcoming ? "coming_soon" : saleEntryControls.length ? "available" : "unknown",
    venue,
    prices: pricesFromText(bodyText),
    currency: "THB",
    purchase_controls: purchaseControls,
    sale_entry_controls: saleEntryControls,
    performance_options: performanceOptions,
    zones: discoveredSeats.zones,
    seat_rows: discoveredSeats.rows,
    seat_map_detected: Boolean(snapshot.seat_map_detected || discoveredSeats.zones.length || discoveredSeats.rows.length),
    evidence,
  };
}

export function evaluateTicketPreflight(facts = {}) {
  const unresolved = [];
  if (!String(facts.event_url || "")) unresolved.push("event_url");
  if (!Array.isArray(facts.show_dates) || !facts.show_dates.some((item) => item?.iso || item?.raw)) unresolved.push("schedule");
  if (!String(facts.sale_open_at || "")) unresolved.push("sale_open_at");
  if (!String(facts.sale_status || "") || facts.sale_status === "unknown") unresolved.push("sale_status");
  const publicPageVerified = unresolved.length === 0 && Array.isArray(facts.evidence) && facts.evidence.length >= 2;
  const saleEntryControls = Array.isArray(facts.sale_entry_controls) ? facts.sale_entry_controls : facts.purchase_controls;
  const purchaseControlsReady = facts.sale_status === "open" && Array.isArray(saleEntryControls) && saleEntryControls.length > 0;
  const saleAt = Date.parse(String(facts.sale_open_at || ""));
  const saleRemainingMs = Number.isFinite(saleAt) ? saleAt - Date.now() : Number.POSITIVE_INFINITY;
  const imminent = facts.sale_status === "upcoming" && saleRemainingMs > 0 && saleRemainingMs <= 30 * 60 * 1000;
  const workflowState = facts.sale_status === "closed" ? "closed"
    : facts.sale_status === "upcoming" ? (imminent ? "armed_pre_sale" : "pre_sale")
      : purchaseControlsReady ? "sale_entry" : "live_entry_unresolved";
  return {
    passed: publicPageVerified,
    public_page_verified: publicPageVerified,
    purchase_controls_ready: purchaseControlsReady,
    sale_entry_controls_ready: purchaseControlsReady,
    sale_opens_within_30_minutes: imminent,
    sale_remaining_seconds: Number.isFinite(saleRemainingMs) ? Math.max(0, Math.ceil(saleRemainingMs / 1000)) : null,
    workflow_state: workflowState,
    unresolved,
    can_build: publicPageVerified && facts.sale_status !== "closed",
    can_run_live_selection: purchaseControlsReady,
  };
}

export function isPlaceholderTicketValue(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return !normalized || /ตาม(?:รอบ|วัน|เวลา|เว็บไซต์)|เลือกในเว็บไซต์|tbd|unknown|not specified/.test(normalized);
}
