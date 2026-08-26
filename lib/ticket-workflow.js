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
  const nextFieldPattern = /\s(?:วันที่แสดง|วันแสดง|สถานที่แสดง|สถานที่|venue|location|ประตูเปิด|วันเปิดจำหน่าย|วันเปิดขาย|เปิดจำหน่าย|เปิดขาย|on\s*sale|ราคาบัตร|ticket\s*price|price|ticket\s*status|สถานะบัตร|สถานะการจำหน่าย|แชร์|share|ผังการแสดง)\s/i;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(labelPattern);
    if (!match || match.index === undefined) continue;
    const tail = line.slice(match.index + match[0].length).replace(/^\s*[:：-]\s*/, "").trim();
    const nextField = tail.search(nextFieldPattern);
    const inline = (nextField >= 0 ? tail.slice(0, nextField) : tail).trim();
    if (inline) return inline.slice(0, maxLength);
    if (lines[index + 1]) return lines[index + 1].slice(0, maxLength);
  }
  return "";
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function thaiDateMentions(value) {
  const text = normalizeTicketText(value);
  const pattern = new RegExp(`(?:วัน[^\\s-]{0,16}ที่\\s*)?(\\d{1,2})\\s+(${MONTH_PATTERN})\\s+(\\d{4})(?:[^\\d\\n]{0,24}(\\d{1,2})[:.](\\d{2}))?`, "gi");
  const dates = [];
  let match;
  while ((match = pattern.exec(text)) && dates.length < 30) {
    const raw = match[0].trim();
    const parsed = parseThaiDateTime(raw);
    if (!parsed.iso) continue;
    dates.push({ raw, iso: parsed.iso });
  }
  const seen = new Set();
  return dates.filter((item) => {
    const key = item.iso || item.raw;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function performanceSchedule(control) {
  const context = normalizeTicketText(control?.context_text || control?.label || "");
  const dates = thaiDateMentions(context);
  if (dates[0]?.iso) return dates[0];
  return { raw: context, iso: "" };
}

function queueWindowFromText(bodyText, fallbackSaleRaw) {
  const text = normalizeTicketText(bodyText);
  const generalIndex = text.search(/จำหน่ายบัตรรอบทั่วไป|general\s+sale/i);
  const segment = generalIndex >= 0 ? text.slice(generalIndex, generalIndex + 700) : text;
  const queueMatch = segment.match(/กดคิว\s*(\d{1,2})[:.](\d{2})\s*(?:น\.)?/i);
  if (!queueMatch) return { raw: "", iso: "" };
  const dates = thaiDateMentions(segment);
  const base = dates[0] || parseThaiDateTime(fallbackSaleRaw);
  if (!base?.iso) return { raw: `กดคิว ${queueMatch[1]}:${queueMatch[2]} น.`, iso: "" };
  const iso = base.iso.replace(/T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/, `T${String(queueMatch[1]).padStart(2, "0")}:${queueMatch[2]}:00+07:00`);
  return { raw: `${base.raw} กดคิว ${queueMatch[1]}:${queueMatch[2]} น.`, iso };
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
    product_name: String(control.product_name || "").slice(0, 160),
    product_type: String(control.product_type || "in_person").slice(0, 40),
    status: /sold\s*out|ขายหมด/i.test(`${control.label || ""} ${control.context_text || ""}`) ? "sold_out" : "open",
    selectable: true,
    semantic_role: String(control.semantic_role || "purchase_action"),
    selector_confidence: Number(control.selector_confidence || 0),
    data_button: String(control.data_button || "").slice(0, 120),
    target_url: String(control.target_url || "").slice(0, 2_000),
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
  const queueOpen = queueWindowFromText(bodyText, saleRaw);
  const combined = `${bodyText}\n${String(snapshot.title || "")}`.toLowerCase();
  const explicitSoldOut = /sold\s*out|ขายหมด/.test(explicitStatus);
  const explicitClosed = /sale\s*ended|closed|cancelled|canceled|ปิดขาย|ยกเลิก|สิ้นสุดแล้ว/.test(explicitStatus);
  const explicitUpcoming = /coming\s*soon|เตรียมเปิดขาย|กำลังจะเปิด|เร็ว\s*ๆ\s*นี้/.test(explicitStatus);
  const explicitOpen = /on\s*sale|available|buy\s*now|เปิดขาย|จำหน่ายแล้ว/.test(explicitStatus);
  // A detail page may contain a mix of open and sold-out performance rows.
  // Page-wide SOLD OUT text must not close the whole event unless every
  // in-person performance is unavailable or the explicit status says so.
  const isClosed = explicitStatus ? explicitClosed : /sale\s*ended|closed|cancelled|canceled|ปิดขาย|ยกเลิก|สิ้นสุดแล้ว/.test(combined);
  const isUpcoming = explicitUpcoming || (!explicitStatus && (
    /coming\s*soon|เตรียมเปิดขาย|กำลังจะเปิด|เร็ว\s*ๆ\s*นี้/.test(combined)
    || (saleDate.iso && Date.parse(saleDate.iso) > Date.now())
  ));
  const rawEntryControls = semanticSaleEntryControls(snapshot.controls);
  const purchaseControls = rawEntryControls.filter((control) => control.semantic_role === "purchase_action");
  const rawPerformanceOptions = rawEntryControls.filter((control) => control.semantic_role === "schedule" && !/^\s*เลือกรอบ\s*\/\s*ประเภทบัตร\s*$/i.test(control.label));
  const announcedPerformanceOptions = (Array.isArray(snapshot.announced_performances) ? snapshot.announced_performances : [])
    .filter((control) => control && typeof control === "object" && thaiDateMentions(control.context_text || control.label).length)
    .map((control) => ({
      selector: String(control.selector || ""),
      label: String(control.label || "").slice(0, 200),
      context_text: String(control.context_text || "").slice(0, 300),
      product_name: String(control.product_name || "").slice(0, 160),
      product_type: String(control.product_type || "in_person").slice(0, 40),
      status: String(control.status || (control.disabled === true ? "upcoming" : "open")).slice(0, 30),
      selectable: control.selectable === true,
      semantic_role: "schedule",
      selector_confidence: control.selector ? 0.98 : 0.6,
      data_button: String(control.data_button || "").slice(0, 120),
      target_url: String(control.target_url || "").slice(0, 2_000),
      announced_before_sale: true,
    }));
  const showDateOptions = announcedPerformanceOptions.length || rawPerformanceOptions.length ? [] : thaiDateMentions(showRaw).map((date) => ({
    selector: "", label: date.raw, context_text: date.raw, semantic_role: "schedule", selector_confidence: 0.5,
    data_button: "", target_url: "", product_name: "", product_type: "in_person", status: "upcoming", selectable: true, announced_before_sale: true,
  }));
  const performanceOptions = [...announcedPerformanceOptions, ...rawPerformanceOptions, ...showDateOptions]
    .map((control) => ({ ...control, schedule: performanceSchedule(control).iso || performanceSchedule(control).raw }))
    .filter((control, index, all) => {
      const key = control.data_button
        ? `button:${control.data_button}`
        : control.target_url
          ? `url:${control.target_url}`
          : `schedule:${control.product_type}\u0000${control.schedule}\u0000${control.label}`;
      return all.findIndex((item) => {
        const itemKey = item.data_button
          ? `button:${item.data_button}`
          : item.target_url
            ? `url:${item.target_url}`
            : `schedule:${item.product_type}\u0000${item.schedule}\u0000${item.label}`;
        return itemKey === key;
      }) === index;
    });
  const actionablePerformanceControls = rawPerformanceOptions.filter((control) => Boolean(control.selector || control.target_url) && /buy\s*(?:now|ticket)|book\s*now|purchase|ซื้อบัตร|จองบัตร/i.test(`${control.label} ${control.context_text}`));
  const saleEntryControls = [...actionablePerformanceControls, ...purchaseControls];
  const inPersonPerformances = performanceOptions.filter((control) => !control.product_type || control.product_type === "in_person");
  const allInPersonSoldOut = inPersonPerformances.length > 0 && inPersonPerformances.every((control) => ["sold_out", "closed"].includes(control.status));
  const saleStatus = explicitSoldOut || allInPersonSoldOut ? "sold_out" : isClosed ? "closed" : isUpcoming ? "upcoming" : explicitOpen || saleEntryControls.length ? "open" : "unknown";
  const discoveredSeats = discoveredSeatValues(snapshot, snapshot.controls);
  const evidence = [];
  if (showRaw) evidence.push({ field: "show_date", text: showRaw.slice(0, 300), source: "page_text" });
  if (saleRaw) evidence.push({ field: "sale_open_at", text: saleRaw.slice(0, 300), source: "page_text" });
  if (queueOpen.raw) evidence.push({ field: "queue_open_at", text: queueOpen.raw.slice(0, 300), source: "page_text" });
  if (venue) evidence.push({ field: "venue", text: venue.slice(0, 300), source: "page_text" });
  if (saleStatus !== "unknown") evidence.push({ field: "sale_status", text: saleStatus, source: "page_state" });
  for (const control of saleEntryControls.slice(0, 8)) evidence.push({ field: control.semantic_role === "schedule" ? "performance_option" : "purchase_control", text: control.label || control.selector, source: "dom_control" });
  return {
    event_name: String(snapshot.title || firstStructured.name || "").trim().slice(0, 500),
    event_url: String(snapshot.url || "").slice(0, 2_000),
    show_dates: thaiDateMentions(showRaw).length ? thaiDateMentions(showRaw) : showRaw ? [{ raw: showDate.raw, iso: showDate.iso }] : [],
    sale_open_at: saleDate.iso,
    sale_open_at_raw: saleDate.raw,
    queue_open_at: queueOpen.iso,
    queue_open_at_raw: queueOpen.raw,
    sale_status: saleStatus,
    ticket_status: explicitSoldOut || allInPersonSoldOut ? "sold_out" : isClosed ? "closed" : isUpcoming ? "coming_soon" : inPersonPerformances.some((item) => item.status === "sold_out") ? "mixed_availability" : saleEntryControls.length ? "available" : "unknown",
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
  const workflowState = facts.sale_status === "sold_out" ? "sold_out"
    : facts.sale_status === "closed" ? "closed"
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
    can_build: publicPageVerified && !["closed", "sold_out"].includes(facts.sale_status),
    can_run_live_selection: purchaseControlsReady,
  };
}

export function isPlaceholderTicketValue(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return !normalized || /ตาม(?:รอบ|วัน|เวลา|เว็บไซต์)|เลือกในเว็บไซต์|tbd|unknown|not specified/.test(normalized);
}
