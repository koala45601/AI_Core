import json
import getpass
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit


payload = json.loads(sys.argv[1])
output = pathlib.Path(os.environ["ALPHA_OUTPUT_DIR"])
output.mkdir(parents=True, exist_ok=True)
event_candidates = payload.get("event_candidates") if isinstance(payload.get("event_candidates"), list) else []
eligible_events = [
    item for item in event_candidates
    if isinstance(item, dict) and str(item.get("sale_status", "")).casefold() in {"open", "upcoming"}
]
selected_id = str(payload.get("selected_event_id", "")).strip()
selected = next((item for item in eligible_events if str(item.get("id", "")) == selected_id), None)
event_name = str(payload.get("selected_event_name", "")).strip()
event_url = str(payload.get("event_url", "")).strip()
if not event_candidates and selected_id and event_name and event_url:
    selected = {"id": selected_id, "name": event_name, "url": event_url, "sale_status": "open"}
if selected:
    event_name = str(selected.get("name", event_name)).strip()
    event_url = str(selected.get("url", event_url)).strip()

facts = payload.get("event_facts") if isinstance(payload.get("event_facts"), dict) else {}
preflight = payload.get("functional_preflight") if isinstance(payload.get("functional_preflight"), dict) else {}
runtime_discovery_required = bool(preflight.get("runtime_discovery_required"))
show_dates = facts.get("show_dates") if isinstance(facts.get("show_dates"), list) else []
first_show = show_dates[0] if show_dates and isinstance(show_dates[0], dict) else {}
schedule = str(payload.get("schedule") or first_show.get("iso") or first_show.get("raw") or "").strip()
sale_open_at = str(payload.get("sale_open_at") or facts.get("sale_open_at") or "").strip()
queue_open_at = str(payload.get("queue_open_at") or "").strip()
seat_mode = str(payload.get("seat_mode", "")).casefold()
seat_grouping = str(payload.get("seat_grouping", "adjacent")).casefold()
zones = [str(item).strip().upper() for item in payload.get("preferred_zones", []) if str(item).strip()] if isinstance(payload.get("preferred_zones"), list) else []
rows = [str(item).strip().upper() for item in payload.get("preferred_rows", []) if str(item).strip()] if isinstance(payload.get("preferred_rows"), list) else []
seat_numbers = [str(item).strip().upper() for item in payload.get("preferred_seat_numbers", []) if str(item).strip()] if isinstance(payload.get("preferred_seat_numbers"), list) else []
seat_fallback_mode = str(payload.get("seat_fallback_mode", "nearest")).casefold()
quantity = max(0, int(payload.get("quantity", 0) or 0))
budget = max(0.0, float(payload.get("budget", 0) or 0))
customer_name = str(payload.get("customer_name", "")).strip()
attendee_names = [str(item).strip() for item in payload.get("attendee_names", []) if str(item).strip()] if isinstance(payload.get("attendee_names"), list) else []
shipping_address = payload.get("shipping_address") if isinstance(payload.get("shipping_address"), dict) else {}
delivery_method = str(payload.get("delivery_method", "pickup")).casefold()
ticket_protect = bool(payload.get("ticket_protect", False))
payment_method = str(payload.get("payment_method", "")).casefold()

missing = []
if not event_url:
    missing.append("event_url")
if not selected or not event_name:
    missing.append("selected_event")
if (not schedule or re.search(r"ตาม(?:รอบ|วัน|เวลา|เว็บไซต์)|เลือกในเว็บไซต์|tbd|unknown", schedule, re.I)) and not runtime_discovery_required:
    missing.append("schedule")
if not sale_open_at and not runtime_discovery_required:
    missing.append("sale_open_at")
if not preflight.get("public_page_verified") and not runtime_discovery_required:
    missing.append("verified_event_facts")
if quantity < 1:
    missing.append("quantity")
if seat_mode not in {"reserved", "standing", "general_admission"}:
    missing.append("seat_mode")
if seat_mode == "reserved" and seat_grouping not in {"adjacent", "same_zone", "any"}:
    missing.append("seat_grouping")
if seat_mode == "reserved" and seat_fallback_mode not in {"exact", "nearest", "zone_any"}:
    missing.append("seat_fallback_mode")
if delivery_method not in {"pickup", "postal"}:
    missing.append("delivery_method")
if delivery_method == "postal" and not shipping_address:
    missing.append("shipping_address")
if payment_method not in {"qr", "promptpay"}:
    missing.append("payment_method")

result = {
    "status": "needs_event_selection" if "selected_event" in missing else "needs_preferences" if missing else "ready_to_build",
    "next_action": "ask_user_for_missing_verified_fields" if missing else "generate_and_verify_project",
    "missing_preferences": sorted(set(missing)),
    "available_event_choices": eligible_events,
    "selected_event": {"id": selected_id, "name": event_name, "url": event_url} if selected_id and event_name else None,
    "schedule": schedule,
    "sale_open_at": sale_open_at,
    "queue_open_at": queue_open_at,
    "event_facts": facts,
    "functional_preflight": preflight,
    "credentials_stored": False,
    "live_purchase_attempted": False,
}

if not missing:
    requested = str(payload.get("project_name") or f"ticket-bot-{urlsplit(event_url).hostname or 'event'}")
    project_name = re.sub(r"[^A-Za-z0-9._-]+", "-", requested).strip("-.")[:80] or "ticket-bot"
    root = pathlib.Path(os.environ.get("ALPHA_PROGRAM_CREATE_DIR", str(output / "Program_Create")))
    root.mkdir(parents=True, exist_ok=True)
    project = root / project_name
    suffix = 2
    while project.exists():
        project = root / f"{project_name}-{suffix}"
        suffix += 1
    destination_project = project
    verification_root = pathlib.Path(tempfile.mkdtemp(prefix="alpha-ticket-verification-"))
    project = verification_root / destination_project.name
    (project / "tests").mkdir(parents=True)

    selectors = payload.get("selectors") if isinstance(payload.get("selectors"), dict) else {}
    config = {
        "generatorVersion": "1.1.0-beta.22",
        "eventId": selected_id,
        "eventName": event_name,
        "eventUrl": event_url,
        "schedule": schedule,
        "saleOpenAt": sale_open_at,
        "runtimeDiscoveryRequired": runtime_discovery_required,
        "queueOpenAt": queue_open_at,
        "saleStatus": str(facts.get("sale_status", "unknown")),
        "quantity": quantity,
        "seatMode": seat_mode,
        "seatGrouping": seat_grouping,
        "preferredZones": zones,
        "preferredRows": rows,
        "preferredSeatNumbers": seat_numbers,
        "seatFallbackMode": seat_fallback_mode,
        "budget": budget,
        "customerName": customer_name,
        "attendeeNames": attendee_names,
        "shippingAddress": shipping_address,
        "deliveryMethod": delivery_method,
        "ticketProtect": ticket_protect,
        "paymentMethod": payment_method,
        "selectors": selectors,
        "purchaseControls": facts.get("purchase_controls", []),
        "saleEntryControls": facts.get("sale_entry_controls", facts.get("purchase_controls", [])),
        "performanceOptions": facts.get("performance_options", []),
        "mouseControl": False,
        "backgroundWindow": True,
        "observedApi": payload.get("captured_api", []) if isinstance(payload.get("captured_api"), list) else [],
        "evidence": facts.get("evidence", []),
        "queue": {
            "retryAfterSeconds": max(2, int(payload.get("retry_after_seconds", 3) or 3)),
            "maxBackoffSeconds": 30,
            "preserveSession": True,
        },
        "credentialEnvironment": {"username": "TICKET_USERNAME", "password": "TICKET_PASSWORD"},
        "handoffPoints": ["captcha", "otp", "payment"],
        "resumeAfterHandoff": True,
    }

    state_machine = r'''import re
from datetime import datetime
from email.utils import parsedate_to_datetime


def _text(snapshot):
    return f"{snapshot.get('url', '')} {snapshot.get('title', '')} {snapshot.get('body', '')}".casefold()


def _actionable_text(snapshot):
    values = []
    for item in snapshot.get("actionable_controls", []) or []:
        if isinstance(item, dict):
            values.append(str(item.get("label", "")))
        else:
            values.append(str(item))
    return " ".join(values).casefold()


def queue_position_from_text(text):
    patterns = [
        r"(?:queue\s*(?:number|position)|your\s*(?:number|position))\s*[:#]?\s*([\d,]+)",
        r"([\d,]+)\s*(?:people|persons|คน)\s*(?:ahead|before you|ก่อนหน้า|อยู่ข้างหน้า)",
        r"(?:คิวที่|ลำดับคิว)\s*[:#]?\s*([\d,]+)",
    ]
    for pattern in patterns:
        match = re.search(pattern, text, re.I)
        if match:
            try:
                return int(match.group(1).replace(",", ""))
            except ValueError:
                pass
    return None


def classify_snapshot(snapshot, now=None, sale_open_at=""):
    text = _text(snapshot)
    actionable_text = _actionable_text(snapshot)
    url = str(snapshot.get("url", "")).casefold()
    body = str(snapshot.get("body", "")).casefold()
    try:
        seat_control_count = max(0, int(snapshot.get("seat_control_count") or 0))
    except (TypeError, ValueError):
        seat_control_count = 0
    queue_position = queue_position_from_text(text)
    evidence = []
    state = "unknown"
    sale_at = None
    current = now
    remaining_seconds = None
    if sale_open_at:
        try:
            sale_at = datetime.fromisoformat(sale_open_at.replace("Z", "+00:00"))
            if current is None and snapshot.get("server_date"):
                current = parsedate_to_datetime(str(snapshot["server_date"]))
            if current is None:
                current = datetime.now(sale_at.tzinfo)
            if current.tzinfo is None and sale_at.tzinfo is not None:
                current = current.replace(tzinfo=sale_at.tzinfo)
            remaining_seconds = (sale_at - current.astimezone(sale_at.tzinfo)).total_seconds()
        except (TypeError, ValueError, OverflowError):
            sale_at = None
            remaining_seconds = None
    try:
        http_status = int(snapshot.get("http_status") or 0)
    except (TypeError, ValueError):
        http_status = 0
    payment_signals = [
        "payment_kbankqr.php" in url or "kpaymentframe" in text,
        bool(re.search(r"ขั้นตอนที่\s*4/4|step\s*4/4", body)),
        bool(re.search(r"หมายเลขการสั่งซื้อ|order\s*(?:number|no\.?|id)", body)),
        bool(re.search(r"remaining\s*time|ภายในเวลา\s*10\s*นาที", body)),
        bool(re.search(r"promptpay|thaiqr|พร้อมเพย์", body)),
    ]
    payment_evidence_count = sum(bool(item) for item in payment_signals)
    if http_status in {429, 500, 502, 503, 504}:
        state, evidence = "server_unavailable", [f"http status {http_status}"]
    elif http_status in {401, 403} or re.search(r"access denied|you don'?t have permission to access|การเข้าถึงถูกปฏิเสธ", text):
        state, evidence = "access_denied", [f"server denied browser access ({http_status or 'page marker'})"]
    elif re.search(r"captcha|recaptcha|hcaptcha|ยืนยันว่า.*มนุษย์", text):
        state, evidence = "captcha_handoff", ["captcha marker"]
    elif re.search(r"otp|one[ -]?time|รหัสยืนยัน", text):
        state, evidence = "otp_handoff", ["otp marker"]
    elif "close-sale" in url or re.search(r"ปิดจำหน่ายบัตรผ่านช่องทางออนไลน์|online\s+sale\s+is\s+closed", body):
        state, evidence = "sale_closed", ["server returned close-sale state"]
    elif re.search(r"join waiting room|join (?:the )?queue|เข้าห้องรอ|กดรับคิว|รับคิว", actionable_text):
        state, evidence = "waiting_room_entry", ["visible and enabled waiting-room control"]
    elif re.search(r"buying queue|you are (?:now )?in (?:the )?(?:buying )?queue|place in line|status last updated|อยู่ในคิว|กำลังเข้าคิว|คิวรอซื้อ", text):
        state, evidence = "queue", ["active queue marker"]
    elif payment_evidence_count >= 3 and ("payment_kbankqr.php" in url or "kpaymentframe" in text):
        state, evidence = "payment_handoff", [f"verified QR payment page ({payment_evidence_count}/5 signals)"]
    elif "paymentall.php" in url or re.search(r"ขั้นตอนที่\s*3/4|เลือกวิธีการชำระเงิน", body):
        state, evidence = "checkout_options", ["delivery and payment options page"]
    elif "enroll.php" in url or re.search(r"กรุณากรอกรายละเอียด|ชื่อ-นามสกุลบน\s*ticket", body):
        state, evidence = "attendee_details", ["event-specific attendee form"]
    elif "verify_condition.php" in url or re.search(r"conditions|เงื่อนไข\s*ข้อตกลง|i accept the terms", body):
        state, evidence = "terms_conditions", ["event terms page"]
    elif "signin.php" in url or (re.search(r"เข้าสู่ระบบ|sign in", body) and re.search(r"รหัสผ่าน|password", body)):
        state, evidence = "login", ["login form"]
    elif "festival.php" in url or re.search(r"เลือกจำนวนบัตร|ขั้นตอนที่\s*2/4", body):
        state, evidence = "quantity_selection", ["ticket quantity page"]
    elif "zones.php" in url or re.search(r"ขั้นตอนที่\s*1/4|เลือกโซน|select\s+(?:round|zone)", body):
        state, evidence = "zone_selection", ["round and zone page"]
    elif seat_control_count > 0:
        state, evidence = "ticket_selection", [f"visible selectable seat controls ({seat_control_count})"]
    elif re.search(r"buy now|buy ticket|book now|purchase|checkout|ซื้อบัตร|จองบัตร", actionable_text):
        state, evidence = "sale_entry", ["visible and enabled purchase control"]
    elif re.search(r"coming soon|เตรียมเปิดขาย|กำลังจะเปิด|เร็ว\s*ๆ\s*นี้|นับถอยหลังเวลารับคิวซื้อบัตร", text) or (remaining_seconds is not None and remaining_seconds > 0):
        imminent = remaining_seconds is not None and 0 < remaining_seconds <= 30 * 60
        state = "armed_pre_sale" if imminent else "pre_sale"
        evidence = ["sale opens within 30 minutes" if imminent else "sale time is more than 30 minutes away"]
    retry_after = snapshot.get("retry_after_seconds")
    try:
        retry_after = max(1, int(retry_after)) if retry_after is not None else None
    except (TypeError, ValueError):
        retry_after = None
    return {
        "state": state,
        "evidence": evidence,
        "url": str(snapshot.get("url", "")),
        "retry_after_seconds": retry_after,
        "sale_remaining_seconds": max(0, round(remaining_seconds, 1)) if remaining_seconds is not None else None,
        "clock_source": "http_date" if snapshot.get("server_date") else "local_clock",
        "queue_position": queue_position,
        "queue_position_verified": queue_position is not None,
        "payment_evidence_count": payment_evidence_count,
        "actionable_control_count": len(snapshot.get("actionable_controls", []) or []),
        "seat_control_count": seat_control_count,
    }


def verified_payment_handoff(checkpoint):
    return checkpoint.get("state") == "payment_handoff" and int(checkpoint.get("payment_evidence_count") or 0) >= 3


def next_action(checkpoint):
    state = checkpoint.get("state")
    return {
        "pre_sale": "wait_for_queue_or_sale_window",
        "armed_pre_sale": "hold_same_session_and_count_down",
        "waiting_room_entry": "join_waiting_room_once",
        "sale_entry": "activate_verified_purchase_control",
        "queue": "keep_same_session_and_wait_retry_after",
        "server_unavailable": "keep_same_session_and_wait_retry_after",
        "access_denied": "stop_and_report_server_access_denied",
        "sale_closed": "stop_and_report_sale_closed",
        "login": "fill_credentials_or_prompt_securely",
        "captcha_handoff": "user_handoff",
        "otp_handoff": "user_handoff",
        "terms_conditions": "accept_terms_and_continue",
        "zone_selection": "select_preferred_zone",
        "quantity_selection": "select_ticket_quantity",
        "ticket_selection": "apply_ticket_preferences",
        "attendee_details": "fill_required_attendee_names",
        "checkout_options": "select_delivery_payment_and_confirm_order",
        "payment_handoff": "user_handoff",
    }.get(state, "stop_and_request_new_evidence")


def _preferred_seat_numbers(values):
    numbers = []
    for value in values or []:
        text = str(value).strip().upper()
        range_match = re.fullmatch(r"(?:[A-Z]+)?(\d+)\s*-\s*(?:[A-Z]+)?(\d+)", text)
        if range_match:
            start, end = sorted((int(range_match.group(1)), int(range_match.group(2))))
            numbers.extend(range(start, min(end, start + 100) + 1))
            continue
        match = re.search(r"(\d+)", text)
        if match:
            numbers.append(int(match.group(1)))
    return list(dict.fromkeys(numbers))


def choose_seat_indices(seats, quantity, grouping="adjacent", preferred_zones=None, preferred_rows=None, preferred_numbers=None, fallback_mode="nearest"):
    wanted = max(1, int(quantity))
    zones = [str(item).upper() for item in (preferred_zones or [])]
    rows = [str(item).upper() for item in (preferred_rows or [])]
    numbers = _preferred_seat_numbers(preferred_numbers)
    available = []
    for index, seat in enumerate(seats):
        if not isinstance(seat, dict) or seat.get("available", True) is False:
            continue
        zone = str(seat.get("zone", "")).upper()
        row = str(seat.get("row", "")).upper()
        number_text = str(seat.get("number", ""))
        number = int(number_text) if number_text.isdigit() else None
        zone_rank = zones.index(zone) if zone in zones else len(zones)
        row_rank = rows.index(row) if row in rows else len(rows)
        number_rank = min((abs(number - target) for target in numbers), default=0) if number is not None else 10**9
        available.append({**seat, "zone": zone, "row": row, "_index": index, "_zone_rank": zone_rank, "_row_rank": row_rank, "_number_rank": number_rank})
    available.sort(key=lambda item: (item["_zone_rank"], item["_row_rank"], item["_number_rank"], str(item.get("zone", "")), str(item.get("row", "")), int(item.get("number", 10**9)) if str(item.get("number", "")).isdigit() else 10**9, item["_index"]))
    if zones:
        in_requested_zones = [item for item in available if item.get("zone") in zones]
        if not in_requested_zones:
            return []
        available = in_requested_zones
    if rows:
        in_requested_rows = [item for item in available if item.get("row") in rows]
        if in_requested_rows:
            available = in_requested_rows
        elif fallback_mode == "exact":
            return []
    if numbers:
        exact = [item for item in available if str(item.get("number", "")).isdigit() and int(item["number"]) in numbers]
        if len(exact) >= wanted:
            available = exact
        elif fallback_mode == "exact":
            return []
    grouped = {}
    for item in available:
        key = str(item.get("zone", "")) if grouping in {"same_zone", "any"} else (str(item.get("zone", "")), str(item.get("row", "")))
        grouped.setdefault(key, []).append(item)
    for items in grouped.values():
        if len(items) < wanted:
            continue
        if grouping in {"same_zone", "any"}:
            return [item["_index"] for item in items[:wanted]]
        numeric = [item for item in items if str(item.get("number", "")).isdigit()]
        for start in range(0, len(numeric) - wanted + 1):
            block = numeric[start:start + wanted]
            numbers = [int(item["number"]) for item in block]
            if numbers == list(range(numbers[0], numbers[0] + wanted)):
                return [item["_index"] for item in block]
    return []
'''

    bot_source = r'''import argparse
import getpass
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

from state_machine import choose_seat_indices, classify_snapshot, next_action, verified_payment_handoff

ROOT = Path(__file__).resolve().parent
CONFIG = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
REPORT = ROOT / "run-report.jsonl"
ACTIONABLE_SELECTOR = "button, a[href], area[href], input[type=button], input[type=submit], input[type=image], [role=button], [role=link], [onclick]"
SEAT_SELECTOR = "[data-seat][data-available='true'], [data-seat][data-status='available'], [role='button'][aria-label*='seat' i]"


def record(kind, payload):
    item = {"at": datetime.now().astimezone().isoformat(), "kind": kind, **payload}
    with REPORT.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(item, ensure_ascii=False) + "\n")
    print(json.dumps(item, ensure_ascii=False), flush=True)


def visible_actionable_controls(page):
    controls = []
    script = r"""els => els.slice(0, 300).map((el, index) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const visible = style.display !== "none" && style.visibility !== "hidden"
        && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
      const disabled = Boolean(el.disabled) || el.getAttribute("aria-disabled") === "true";
      const label = [
        el.innerText,
        el.getAttribute("aria-label"),
        el.getAttribute("value"),
        el.getAttribute("alt"),
        el.getAttribute("title"),
      ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      return {index, label, visible, disabled, tag: el.tagName.toLowerCase()};
    }).filter(item => item.visible && !item.disabled && item.label)"""
    for frame_index, scope in enumerate([page, *page.frames]):
        try:
            rows = scope.locator(ACTIONABLE_SELECTOR).evaluate_all(script)
        except Exception:
            continue
        for row in rows:
            controls.append({
                "label": str(row.get("label", ""))[:300],
                "tag": str(row.get("tag", ""))[:40],
                "frame_index": frame_index,
                "control_index": int(row.get("index", 0)),
            })
    return controls


def visible_seat_control_count(page):
    total = 0
    for scope in [page, *page.frames]:
        try:
            seats = scope.locator(SEAT_SELECTOR)
            for index in range(min(seats.count(), 1000)):
                seat = seats.nth(index)
                if seat.is_visible(timeout=100) and seat.is_enabled(timeout=100):
                    total += 1
        except Exception:
            continue
    return total


def snapshot(page, retry_after_seconds=None, http_status=None, server_date=None):
    bodies = []
    frame_urls = []
    for frame in page.frames:
        try:
            bodies.append(frame.locator("body").inner_text(timeout=2500))
            frame_urls.append(frame.url)
        except Exception:
            pass
    return {
        "url": page.url,
        "title": page.title(),
        "body": "\n".join(bodies),
        "frame_urls": frame_urls,
        "retry_after_seconds": retry_after_seconds,
        "http_status": http_status,
        "server_date": server_date,
        "actionable_controls": visible_actionable_controls(page),
        "seat_control_count": visible_seat_control_count(page),
    }


def semantic_click(page, labels):
    pattern = re.compile("|".join(re.escape(label) for label in labels), re.I)
    for scope in [page, *page.frames]:
        for role in ("button", "link"):
            locator = scope.get_by_role(role, name=pattern).first
            try:
                if locator.is_visible(timeout=500) and locator.is_enabled():
                    label = locator.inner_text(timeout=500)
                    locator.click()
                    record("action", {"action": "click", "role": role, "label": label[:200], "frame_url": getattr(scope, "url", page.url)})
                    return True
            except Exception:
                pass
    for scope in [page, *page.frames]:
        locator = scope.locator(ACTIONABLE_SELECTOR)
        try:
            count = min(locator.count(), 300)
        except Exception:
            continue
        for index in range(count):
            control = locator.nth(index)
            try:
                if not control.is_visible(timeout=150) or not control.is_enabled(timeout=150):
                    continue
                label = " ".join(filter(None, [
                    control.inner_text(timeout=150),
                    control.get_attribute("aria-label", timeout=150),
                    control.get_attribute("value", timeout=150),
                    control.get_attribute("alt", timeout=150),
                    control.get_attribute("title", timeout=150),
                ])).strip()
                if label and pattern.search(label):
                    control.click()
                    record("action", {"action": "click", "label": label[:200], "frame_url": getattr(scope, "url", page.url), "evidence": "visible_actionable_control"})
                    return True
            except Exception:
                pass
    for control in CONFIG.get("purchaseControls", []):
        selector = str(control.get("selector", ""))
        if not selector:
            continue
        try:
            locator = page.locator(selector).first
            if locator.is_visible(timeout=500) and locator.is_enabled():
                locator.click()
                record("action", {"action": "click", "selector": selector, "evidence": control.get("label", "")})
                return True
        except Exception:
            pass
    return False


def semantic_select_if_present(page, wanted_labels, family_labels, field_name):
    """Select an option only when that option family exists on the current page.

    Ticket forms differ per event. An absent delivery/payment family is therefore a
    valid no-op, while a visible family whose requested choice cannot be selected is
    a real failure. This keeps event-specific fields out of the global workflow.
    """
    wanted = re.compile("|".join(re.escape(label) for label in wanted_labels), re.I)
    family = re.compile("|".join(re.escape(label) for label in family_labels), re.I)
    family_present = False
    for scope in [page, *page.frames]:
        for role in ("radio", "button", "link"):
            family_locator = scope.get_by_role(role, name=family).first
            try:
                if family_locator.count() and family_locator.is_visible(timeout=300):
                    family_present = True
            except Exception:
                pass
            locator = scope.get_by_role(role, name=wanted).first
            try:
                if not locator.count() or not locator.is_visible(timeout=300):
                    continue
                family_present = True
                if role == "radio" and locator.is_checked():
                    record("action", {"action": "option_already_selected", "field": field_name})
                    return "selected"
                if locator.is_enabled():
                    locator.click(force=role == "radio")
                    record("action", {"action": "select_option", "field": field_name, "role": role})
                    return "selected"
            except Exception:
                pass
        try:
            family_text = scope.get_by_text(family).first
            if family_text.count() and family_text.is_visible(timeout=300):
                family_present = True
            wanted_text = scope.get_by_text(wanted).first
            if wanted_text.count() and wanted_text.is_visible(timeout=300):
                wanted_text.evaluate("element => (element.closest('label,button,a') || element).click()")
                record("action", {"action": "select_option", "field": field_name, "role": "label"})
                return "selected"
        except Exception:
            pass
    if not family_present:
        record("action", {"action": "event_specific_option_absent", "field": field_name, "skipped": True})
        return "absent"
    return "failed"


def field_descriptor(locator):
    try:
        return str(locator.evaluate("""element => {
            const labels = element.labels ? Array.from(element.labels).map(item => item.innerText || item.textContent || '') : [];
            return [element.getAttribute('aria-label'), element.getAttribute('placeholder'), element.getAttribute('name'), element.id, ...labels]
              .filter(Boolean).join(' ');
        }""") or "").strip()
    except Exception:
        return ""


def sale_entry_labels():
    labels = []
    schedule = str(CONFIG.get("schedule", ""))
    labels.extend(re.findall(r"\b\d{1,2}:\d{2}\b", schedule))
    for control in CONFIG.get("saleEntryControls", CONFIG.get("purchaseControls", [])):
        label = str(control.get("label", "")).strip()
        if label:
            labels.append(label)
    labels.extend(["เลือกรอบ/ประเภทบัตร", "ซื้อบัตร", "จองบัตร", "buy now", "book now"])
    return list(dict.fromkeys(labels))


def fill_login(page):
    username = os.environ.get("TICKET_USERNAME", "").strip()
    password = os.environ.get("TICKET_PASSWORD", "")
    if not username:
        record("input_required", {"field": "username", "stage": "waiting_username", "prompt": "กรอกอีเมล/ชื่อผู้ใช้สำหรับเว็บขายบัตร", "secret": False})
        username = input("อีเมล/ชื่อผู้ใช้สำหรับเว็บขายบัตรนี้: ").strip()
    if not password:
        record("input_required", {"field": "password", "stage": "waiting_password", "prompt": "กรอกรหัสผ่านสำหรับเว็บขายบัตร", "secret": True})
        password = getpass.getpass("รหัสผ่าน (ไม่แสดงและไม่บันทึก): ")
    username_box = page.get_by_role("textbox", name=re.compile(r"ชื่อผู้ใช้|อีเมล|email|username", re.I)).first
    password_box = page.locator("input[type='password']").first
    if not username or not password or username_box.count() == 0 or password_box.count() == 0:
        return False
    username_box.fill(username)
    password_box.fill(password)
    if not semantic_click(page, ["เข้าสู่ระบบ", "login", "sign in"]):
        return False
    record("action", {"action": "login_submit", "credentials_persisted": False, "same_session": True})
    return True


def authenticated_account_marker(page):
    marker = re.compile(r"ออกจากระบบ|log\s*out|บัญชีของฉัน|my\s*account|ข้อมูลสมาชิก|member\s*profile", re.I)
    for scope in [page, *page.frames]:
        try:
            locator = scope.get_by_text(marker).first
            if locator.count() and locator.is_visible(timeout=300):
                return True
        except Exception:
            pass
    return False


def accept_event_terms(page):
    checkbox = page.get_by_role("checkbox", name=re.compile(r"ยอมรับข้อกำหนด|ยอมรับ.*เงื่อนไข|accept.*terms", re.I)).first
    try:
        if checkbox.count() and not checkbox.is_checked():
            checkbox.check(force=True)
    except Exception:
        return False
    clicked = semantic_click(page, ["ซื้อบัตร / Buy Ticket", "ซื้อบัตร", "Buy Ticket", "ดำเนินการต่อ", "Continue"])
    if clicked:
        record("action", {"action": "accept_event_terms"})
    return clicked


def select_preferred_zone(page):
    zones = [str(item).strip().upper() for item in CONFIG.get("preferredZones", []) if str(item).strip()]
    area_nodes = page.locator("area[href*='#']")
    discovered = []
    for index in range(area_nodes.count()):
        href = area_nodes.nth(index).get_attribute("href") or ""
        zone = href.rsplit("#", 1)[-1].upper() if "#" in href else ""
        if zone and len(zone) <= 30:
            discovered.append((zone, area_nodes.nth(index)))
    for selector in ("[data-zone]", "[data-section]"):
        nodes = page.locator(selector)
        for index in range(min(nodes.count(), 500)):
            node = nodes.nth(index)
            zone = (node.get_attribute("data-zone") or node.get_attribute("data-section") or "").strip().upper()
            if zone and len(zone) <= 30 and all(item[0] != zone for item in discovered):
                discovered.append((zone, node))
    discovered_names = list(dict.fromkeys(zone for zone, _ in discovered))
    if not zones:
        print("โซนที่พบจากหน้าจริง: " + (", ".join(discovered_names) if discovered_names else "ยังอ่านชื่อโซนไม่ได้"), flush=True)
        record("input_required", {"field": "zone", "stage": "waiting_zone", "options": discovered_names, "prompt": "เลือกโซนก่อนให้บอททำต่อ", "secret": False})
        answer = input("เลือกโซนก่อนให้บอททำต่อ (เช่น A หรือ A1; หลายโซนคั่นด้วย comma): ").strip().upper()
        zones = [item.strip() for item in re.split(r"[,\n]", answer) if item.strip()]
        if not zones:
            record("selection", {"mode": "zone", "preferred": [], "discovered": discovered_names, "complete": False, "reason": "USER_ZONE_REQUIRED"})
            return False
    ordered = zones
    for zone in ordered:
        for discovered_zone, locator in discovered:
            if discovered_zone != zone:
                continue
            locator.evaluate("element => element.click()")
            record("action", {"action": "select_image_map_zone", "zone": zone, "selector": f"area[href$='#{zone}']"})
            return True
        locator = page.get_by_text(zone, exact=True).first
        try:
            if locator.count() and locator.is_visible(timeout=500) and locator.is_enabled():
                locator.click()
                record("action", {"action": "select_zone", "zone": zone})
                return True
        except Exception:
            pass
    record("selection", {"mode": "zone", "preferred": zones, "discovered": discovered_names, "complete": False})
    return False


def select_ticket_quantity(page):
    wanted = max(1, int(CONFIG.get("quantity", 1)))
    selects = page.locator("select")
    selected = False
    for index in range(selects.count()):
        locator = selects.nth(index)
        labels = [str(item).strip() for item in locator.locator("option").all_text_contents()]
        if str(wanted) not in labels:
            continue
        try:
            locator.select_option(label=str(wanted))
        except Exception:
            locator.select_option(str(wanted))
        selected = True
        break
    if not selected:
        locator = page.get_by_label(re.compile(r"quantity|qty|จำนวน", re.I)).first
        try:
            if locator.count() and locator.is_visible(timeout=500):
                locator.fill(str(wanted))
                selected = True
        except Exception:
            pass
    if not selected:
        return False
    if not semantic_click(page, ["ยืนยันที่นั่ง", "ยืนยัน", "ดำเนินการต่อ", "continue", "next"]):
        return False
    record("selection", {"mode": CONFIG.get("seatMode"), "wanted": wanted, "selected": wanted, "complete": True})
    return True


def fill_attendee_details(page):
    boxes = page.locator("input[type='text'], input:not([type])")
    names = [str(item).strip() for item in CONFIG.get("attendeeNames", []) if str(item).strip()]
    fallback = str(CONFIG.get("customerName", "")).strip()
    candidates = []
    for index in range(boxes.count()):
        locator = boxes.nth(index)
        try:
            if not locator.is_visible(timeout=300) or not locator.is_enabled():
                continue
        except Exception:
            continue
        descriptor = field_descriptor(locator)
        if re.search(r"search|ค้นหา|coupon|promo", descriptor, re.I):
            continue
        if re.search(r"ชื่อ|name|attendee|ticket|ผู้เข้าชม", descriptor, re.I) or boxes.count() <= max(1, int(CONFIG.get("quantity", 1))):
            candidates.append((locator, descriptor))
    count = len(candidates)
    for index, (locator, descriptor) in enumerate(candidates):
        if index < len(names):
            value = names[index]
        elif fallback and count == 1:
            value = fallback
        else:
            prompt_label = descriptor or f"บัตรใบที่ {index + 1}"
            record("input_required", {"field": "event_specific", "stage": "waiting_event_field", "prompt": f"หน้าเว็บคอนนี้ต้องการข้อมูล {prompt_label}", "secret": False})
            value = input(f"หน้าเว็บคอนนี้ต้องการข้อมูล '{prompt_label}': ").strip()
        if not value:
            return False
        locator.fill(value)
    if count == 0:
        record("action", {"action": "event_specific_attendee_fields_absent", "skipped": True})
        return semantic_click(page, ["บันทึก", "save", "ดำเนินการต่อ", "continue"])
    if not semantic_click(page, ["บันทึก", "save", "ดำเนินการต่อ", "continue"]):
        return False
    record("action", {"action": "fill_attendee_details", "count": count, "values_logged": False})
    return True


def select_checkout_options(page, confirm_order=False):
    delivery = str(CONFIG.get("deliveryMethod", "pickup"))
    delivery_labels = ["รับบัตรด้วยตนเอง", "self pickup", "pick up"] if delivery == "pickup" else ["จัดส่งทางไปรษณีย์", "postal", "delivery"]
    delivery_result = semantic_select_if_present(
        page,
        delivery_labels,
        ["รับบัตรด้วยตนเอง", "self pickup", "pick up", "จัดส่งทางไปรษณีย์", "postal", "delivery"],
        "delivery_method",
    )
    if delivery_result == "failed":
        return False
    payment = str(CONFIG.get("paymentMethod", "qr"))
    payment_labels = ["QR", "PromptPay", "พร้อมเพย์"] if payment in {"qr", "promptpay"} else [payment]
    payment_result = semantic_select_if_present(
        page,
        payment_labels,
        ["QR", "PromptPay", "พร้อมเพย์", "credit card", "บัตรเครดิต", "debit", "ชำระเงิน"],
        "payment_method",
    )
    if payment_result == "failed":
        return False
    protect = page.get_by_role("checkbox", name=re.compile(r"Ticket Protect", re.I)).first
    try:
        if protect.count() and protect.is_checked() and not bool(CONFIG.get("ticketProtect", False)):
            protect.uncheck(force=True)
    except Exception:
        pass
    agreement = page.get_by_role("checkbox", name=re.compile(r"ยอมรับข้อตกลงในการใช้บริการ|accept.*service", re.I)).first
    try:
        if agreement.count() and not agreement.is_checked():
            agreement.check(force=True)
    except Exception:
        return False
    if not confirm_order:
        record("handoff", {"status": "ORDER_CONFIRMATION_REQUIRED", "same_session": True, "next_action": "rerun_with_--confirm-order"})
        return None
    clicked = semantic_click(page, ["ยืนยันการสั่งซื้อ", "confirm order"])
    if clicked:
        record("action", {"action": "confirm_unpaid_order", "payment_submitted": False})
    return clicked


def apply_ticket_preferences(page):
    wanted = max(1, int(CONFIG.get("quantity", 1)))
    zones = [str(item) for item in CONFIG.get("preferredZones", []) if str(item)]
    rows = [str(item) for item in CONFIG.get("preferredRows", []) if str(item)]
    seat_numbers = [str(item) for item in CONFIG.get("preferredSeatNumbers", []) if str(item)]
    fallback_mode = str(CONFIG.get("seatFallbackMode", "nearest"))
    for zone in zones:
        try:
            locator = page.get_by_text(zone, exact=True).first
            if locator.is_visible(timeout=500) and locator.is_enabled():
                locator.click()
                record("action", {"action": "select_zone", "zone": zone})
                break
        except Exception:
            pass
    if CONFIG.get("seatMode") == "reserved":
        seats = page.locator("[data-seat][data-available='true'], [data-seat][data-status='available'], [role='button'][aria-label*='seat' i]")
        metadata = []
        for index in range(min(seats.count(), 1000)):
            seat = seats.nth(index)
            try:
                metadata.append({
                    "zone": seat.get_attribute("data-zone") or seat.get_attribute("data-section") or "",
                    "row": seat.get_attribute("data-row") or "",
                    "number": seat.get_attribute("data-seat-number") or seat.get_attribute("data-seat") or "",
                    "available": seat.is_visible() and seat.is_enabled(),
                })
            except Exception:
                metadata.append({"available": False})
        grouping = str(CONFIG.get("seatGrouping", "adjacent"))
        selected_indices = choose_seat_indices(metadata, wanted, grouping, zones, rows, seat_numbers, fallback_mode)
        for index in selected_indices:
            seats.nth(index).click()
        selected = len(selected_indices)
        record("selection", {"mode": "reserved", "grouping": grouping, "wanted": wanted, "selected": selected, "indices": selected_indices, "preferred_zones": zones, "preferred_rows": rows, "preferred_seat_numbers": seat_numbers, "fallback_mode": fallback_mode, "complete": selected == wanted})
        return selected == wanted
    label_pattern = re.compile(r"quantity|qty|จำนวน", re.I)
    locator = page.get_by_label(label_pattern).first
    try:
        if locator.is_visible(timeout=500) and locator.is_enabled():
            tag = locator.evaluate("element => element.tagName.toLowerCase()")
            if tag == "select":
                locator.select_option(str(wanted))
            else:
                locator.fill(str(wanted))
            record("selection", {"mode": CONFIG.get("seatMode"), "wanted": wanted, "selected": wanted, "complete": True})
            return True
    except Exception:
        pass
    record("selection", {"mode": CONFIG.get("seatMode"), "wanted": wanted, "selected": 0, "complete": False})
    return False


def verify_fixtures():
    completed = subprocess.run([sys.executable, str(ROOT / "tests" / "test_state_machine.py")], cwd=ROOT, text=True, capture_output=True)
    print(completed.stdout, end="")
    print(completed.stderr, end="", file=sys.stderr)
    return completed.returncode


def wait_until(value, label):
    if not value:
        return
    target = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    while datetime.now(target.tzinfo) < target:
        remaining = (target - datetime.now(target.tzinfo)).total_seconds()
        if remaining <= 0:
            break
        record("wait", {"state": label, "remaining_seconds": round(remaining, 1)})
        time.sleep(min(30, max(0.2, remaining)))


def run_live(inspect_only=False, wait_for_window=False, confirm_order=False):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as runtime:
        context = runtime.chromium.launch_persistent_context(
            str(ROOT / "browser-profile"),
            channel="chrome",
            headless=False,
            args=["--start-minimized", "--no-first-run"],
        )
        record("runtime", {"mouse_control": False, "background_window": True, "profile": "isolated"})
        page = context.pages[-1] if context.pages else context.new_page()
        observed = {"retry_after": None, "http_status": None, "server_date": None}
        login_submitted = False
        login_verified = False

        def on_response(response):
            value = response.headers.get("retry-after")
            if value and str(value).isdigit():
                observed["retry_after"] = int(value)
            if response.request.resource_type == "document":
                observed["http_status"] = response.status
                observed["server_date"] = response.headers.get("date") or observed["server_date"]

        page.on("response", on_response)
        page.goto(CONFIG["eventUrl"], wait_until="domcontentloaded", timeout=45000)
        checkpoint = classify_snapshot(snapshot(page, observed["retry_after"], observed["http_status"], observed["server_date"]), sale_open_at=CONFIG.get("saleOpenAt", ""))
        record("checkpoint", {**checkpoint, "next_action": next_action(checkpoint), "live": True})
        if inspect_only:
            context.close()
            return 0
        if checkpoint["state"] in {"pre_sale", "armed_pre_sale"} and not wait_for_window:
            record("result", {"status": "ARMED_PRE_SALE" if checkpoint["state"] == "armed_pre_sale" else "PRE_SALE_READY", "live_checkout_verified": False})
            context.close()
            return 0
        if checkpoint["state"] in {"pre_sale", "armed_pre_sale"}:
            wait_until(CONFIG.get("queueOpenAt") or CONFIG.get("saleOpenAt"), "waiting_for_queue_window")
            page.reload(wait_until="domcontentloaded")
            checkpoint = classify_snapshot(snapshot(page, observed["retry_after"], observed["http_status"], observed["server_date"]), sale_open_at=CONFIG.get("saleOpenAt", ""))
            record("checkpoint", {**checkpoint, "next_action": next_action(checkpoint), "live": True})
        queue_rounds = 0
        pre_sale_rounds = 0
        discovery_rounds = 0
        workflow_steps = 0
        while True:
            checkpoint = classify_snapshot(snapshot(page, observed["retry_after"], observed["http_status"], observed["server_date"]), sale_open_at=CONFIG.get("saleOpenAt", ""))
            record("checkpoint", {**checkpoint, "next_action": next_action(checkpoint), "live": True})
            state = checkpoint["state"]
            if not login_verified and authenticated_account_marker(page):
                login_verified = True
                record("authentication", {"status": "EXISTING_SESSION_VERIFIED", "method": "account_marker", "credentials_persisted": False})
            if login_submitted and state not in {"login", "captcha_handoff", "otp_handoff", "unknown", "server_unavailable"} and not login_verified:
                login_verified = True
                record("authentication", {"status": "LOGIN_VERIFIED", "method": "successful_form_transition", "credentials_persisted": False})
            if state not in {"pre_sale", "armed_pre_sale", "queue", "server_unavailable", "unknown"}:
                workflow_steps += 1
                if workflow_steps > 30:
                    record("result", {"status": "WORKFLOW_TRANSITION_LIMIT", "live_checkout_verified": False})
                    break
            if state in {"pre_sale", "armed_pre_sale"}:
                pre_sale_rounds += 1
                wait_seconds = 10 if state == "armed_pre_sale" else 30
                record("wait", {
                    "state": state,
                    "seconds": wait_seconds,
                    "same_session": True,
                    "reason": "waiting_for_visible_queue_or_sale_control",
                    "sale_remaining_seconds": checkpoint.get("sale_remaining_seconds"),
                    "page_refresh": pre_sale_rounds % 6 == 0,
                })
                page.wait_for_timeout(wait_seconds * 1000)
                if pre_sale_rounds % 6 == 0:
                    page.reload(wait_until="domcontentloaded")
                continue
            if state == "unknown" and CONFIG.get("runtimeDiscoveryRequired"):
                discovery_rounds += 1
                wait_seconds = 15
                record("wait", {
                    "state": "runtime_discovery",
                    "seconds": wait_seconds,
                    "same_session": True,
                    "reason": "waiting_for_visible_queue_or_sale_control",
                    "round": discovery_rounds,
                    "page_refresh": discovery_rounds % 4 == 0,
                })
                page.wait_for_timeout(wait_seconds * 1000)
                if discovery_rounds % 4 == 0:
                    page.reload(wait_until="domcontentloaded")
                continue
            if state == "waiting_room_entry":
                if not semantic_click(page, ["Join waiting room", "Join the queue", "Join queue", "เข้าห้องรอ", "กดรับคิว", "รับคิว"]):
                    refreshed = classify_snapshot(snapshot(page, observed["retry_after"], observed["http_status"], observed["server_date"]), sale_open_at=CONFIG.get("saleOpenAt", ""))
                    record("recovery", {"status": "WAITING_ROOM_CONTROL_CHANGED", "previous_state": state, "current_state": refreshed["state"], "actionable_control_count": refreshed.get("actionable_control_count", 0)})
                    if refreshed["state"] != "waiting_room_entry":
                        checkpoint = refreshed
                        page.wait_for_timeout(500)
                        continue
                    record("result", {"status": "WAITING_ROOM_CONTROL_NOT_VERIFIED", "live_queue_observed": False, "live_checkout_verified": False, "reason": "visible control disappeared or could not be activated"})
                    context.close()
                    return 2
                record("queue", {"status": "WAITING_ROOM_JOINED", "clicked_once": True, "same_session": True})
                page.wait_for_timeout(1000)
                continue
            if state in {"queue", "server_unavailable"}:
                queue_rounds += 1
                wait_seconds = checkpoint.get("retry_after_seconds") or CONFIG["queue"]["retryAfterSeconds"]
                wait_seconds = min(CONFIG["queue"]["maxBackoffSeconds"], max(2, wait_seconds))
                if state == "queue":
                    record("wait", {"state": state, "seconds": wait_seconds, "same_session": True, "round": queue_rounds, "page_refresh": False, "auto_update": True, "queue_position": checkpoint.get("queue_position"), "queue_position_verified": checkpoint.get("queue_position_verified", False)})
                    page.wait_for_timeout(wait_seconds * 1000)
                else:
                    record("wait", {"state": state, "seconds": wait_seconds, "same_session": True, "round": queue_rounds, "page_refresh": True})
                    time.sleep(wait_seconds)
                    page.reload(wait_until="domcontentloaded")
                continue
            if state == "sale_entry":
                if not semantic_click(page, sale_entry_labels()):
                    record("result", {"status": "SALE_CONTROL_NOT_VERIFIED", "live_checkout_verified": False})
                    context.close()
                    return 2
                page.wait_for_timeout(1000)
                continue
            if state == "sale_closed":
                record("result", {"status": "SALE_CLOSED_BY_SERVER", "live_checkout_verified": False, "url": page.url})
                context.close()
                return 4
            if state == "access_denied":
                record("result", {"status": "SERVER_ACCESS_DENIED", "reason": "เว็บไซต์ปฏิเสธ browser session นี้; ปิดหน้าต่างซ้ำและรอให้ session/IP ฟื้นก่อนลองใหม่", "live_checkout_verified": False, "url": page.url})
                context.close()
                return 5
            if state == "login":
                if not fill_login(page):
                    record("result", {"status": "LOGIN_FORM_NOT_VERIFIED", "live_checkout_verified": False})
                    context.close()
                    return 2
                login_submitted = True
                page.wait_for_timeout(1500)
                after_login = classify_snapshot(snapshot(page, observed["retry_after"], observed["http_status"], observed["server_date"]), sale_open_at=CONFIG.get("saleOpenAt", ""))
                if after_login["state"] == "login":
                    record("result", {"status": "LOGIN_FAILED_OR_FORM_STILL_VISIBLE", "live_checkout_verified": False, "credentials_persisted": False})
                    context.close()
                    return 2
                continue
            if state in {"captcha_handoff", "otp_handoff"}:
                record("handoff", {"status": state.upper(), "resume_supported": True, "same_session": True})
                record("input_required", {"field": "captcha" if state == "captcha_handoff" else "otp", "stage": "waiting_captcha" if state == "captcha_handoff" else "waiting_otp", "prompt": "รับช่วงใน Chrome แล้วกดทำต่อ", "secret": False})
                input("รับช่วงในหน้าต่าง Chrome เฉพาะขั้นนี้ แล้วกลับมากด Enter; บอทจะทำงานต่อด้วย session เดิม: ")
                page.wait_for_timeout(500)
                continue
            if state == "terms_conditions":
                if not accept_event_terms(page):
                    record("result", {"status": "TERMS_CONTINUE_CONTROL_NOT_VERIFIED", "live_checkout_verified": False})
                    context.close()
                    return 2
                page.wait_for_timeout(1000)
                continue
            if state == "zone_selection":
                if not select_preferred_zone(page):
                    record("result", {"status": "ZONE_NOT_SELECTED", "preferred_zones": CONFIG.get("preferredZones", []), "live_checkout_verified": False})
                    context.close()
                    return 2
                page.wait_for_timeout(1000)
                continue
            if state == "quantity_selection":
                if not select_ticket_quantity(page):
                    record("result", {"status": "TICKET_QUANTITY_NOT_COMPLETE", "wanted": CONFIG.get("quantity"), "live_checkout_verified": False})
                    context.close()
                    return 2
                page.wait_for_timeout(1000)
                continue
            if state == "ticket_selection":
                if not apply_ticket_preferences(page):
                    record("result", {"status": "TICKET_QUANTITY_NOT_COMPLETE", "wanted": CONFIG.get("quantity"), "live_checkout_verified": False})
                    record("input_required", {"field": "ticket_selection", "stage": "waiting_ticket_selection", "prompt": "เลือกบัตรให้ครบใน Chrome แล้วกดทำต่อ", "secret": False})
                    input("เลือกบัตรให้ครบใน Chrome แล้วกลับมากด Enter เพื่อให้บอททำต่อ: ")
                    continue
                if not semantic_click(page, ["ดำเนินการต่อ", "ถัดไป", "continue", "next", "ยืนยัน"]):
                    record("result", {"status": "CONTINUE_CONTROL_NOT_VERIFIED", "live_checkout_verified": False})
                    record("input_required", {"field": "continue", "stage": "waiting_manual_continue", "prompt": "ตรวจรายการและกดดำเนินการต่อใน Chrome แล้วกดทำต่อ", "secret": False})
                    input("ตรวจรายการและกดดำเนินการต่อใน Chrome แล้วกลับมากด Enter: ")
                page.wait_for_timeout(1000)
                continue
            if state == "attendee_details":
                if not fill_attendee_details(page):
                    record("result", {"status": "ATTENDEE_DETAILS_INCOMPLETE", "live_checkout_verified": False})
                    context.close()
                    return 2
                page.wait_for_timeout(1000)
                continue
            if state == "checkout_options":
                if not login_verified:
                    record("result", {"status": "LOGIN_REQUIRED_BEFORE_CHECKOUT", "live_checkout_verified": False, "credentials_persisted": False})
                    context.close()
                    return 2
                checkout_result = select_checkout_options(page, confirm_order=confirm_order)
                if checkout_result is None:
                    record("input_required", {"field": "checkout_options", "stage": "waiting_checkout_options", "prompt": "เลือกวิธีรับบัตร/QR ใน Chrome แล้วกดทำต่อ", "secret": False})
                    input("เลือกวิธีรับบัตร/QR แล้ว ระบบหยุดก่อนสร้างคำสั่งซื้อ กด Enter เพื่อปิด หรือรันใหม่ด้วย --confirm-order: ")
                    context.close()
                    return 0
                if not checkout_result:
                    record("result", {"status": "CHECKOUT_OPTIONS_INCOMPLETE", "live_checkout_verified": False})
                    context.close()
                    return 2
                page.wait_for_timeout(1500)
                continue
            if state == "payment_handoff":
                if not login_verified:
                    record("result", {"status": "LOGIN_REQUIRED_BEFORE_PAYMENT", "live_checkout_verified": False, "credentials_persisted": False})
                    context.close()
                    return 2
                record("result", {"status": "PAYMENT_HANDOFF", "login_verified": True, "live_checkout_verified": verified_payment_handoff(checkpoint), "payment_not_submitted": True, "payment_evidence_count": checkpoint.get("payment_evidence_count")})
                record("input_required", {"field": "payment", "stage": "payment_handoff", "prompt": "ถึงหน้าชำระเงินจริงแล้ว ระบบหยุดก่อนจ่าย", "secret": False})
                input("ถึงหน้าชำระเงินจริงแล้ว ระบบหยุดก่อนจ่าย กด Enter เมื่อพี่ตรวจเสร็จ: ")
                context.close()
                return 0
            break
        record("result", {"status": "STOPPED_WITHOUT_VERIFIED_PAYMENT_HANDOFF", "state": checkpoint["state"], "live_checkout_verified": False})
        record("input_required", {"field": "review", "stage": "waiting_review", "prompt": "หลักฐานยังไม่พอ ตรวจใน Chrome แล้วกดทำต่อเพื่อปิด", "secret": False})
        input("หลักฐานยังไม่พอ ระบบหยุดไว้ให้ตรวจใน Chrome กด Enter เพื่อปิด: ")
        context.close()
        return 3


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--inspect-only", action="store_true")
    parser.add_argument("--wait-for-window", action="store_true")
    parser.add_argument("--confirm-order", action="store_true", help="สร้างคำสั่งซื้อที่ยังไม่ชำระเพื่อไปถึงหน้า QR")
    args = parser.parse_args()
    if args.dry_run:
        raise SystemExit(verify_fixtures())
    raise SystemExit(run_live(args.inspect_only, args.wait_for_window, args.confirm_order))


if __name__ == "__main__":
    main()
'''

    test_source = r'''import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from state_machine import choose_seat_indices, classify_snapshot, next_action, verified_payment_handoff


class TicketStateMachineTests(unittest.TestCase):
    def state(self, body, url="https://tickets.test/event", retry=None, status=None, controls=None, seat_controls=0):
        return classify_snapshot({"body": body, "url": url, "title": "Fixture", "retry_after_seconds": retry, "http_status": status, "actionable_controls": controls or [], "seat_control_count": seat_controls})

    def test_pre_sale(self):
        self.assertEqual(self.state("COMING SOON เปิดขายเร็ว ๆ นี้")["state"], "pre_sale")

    def test_queue_countdown_copy_is_pre_sale_without_join_control(self):
        self.assertEqual(self.state("นับถอยหลังเวลารับคิวซื้อบัตร")["state"], "pre_sale")

    def test_access_denied_is_reported_explicitly(self):
        result = self.state("Access Denied You don't have permission to access this page", status=403)
        self.assertEqual(result["state"], "access_denied")
        self.assertEqual(next_action(result), "stop_and_report_server_access_denied")

    def test_sale_within_thirty_minutes_is_armed(self):
        result = classify_snapshot(
            {"body": "COMING SOON", "url": "https://tickets.test/event", "title": "Fixture"},
            now=datetime(2026, 8, 24, 2, 35, tzinfo=timezone.utc),
            sale_open_at="2026-08-24T10:00:00+07:00",
        )
        self.assertEqual(result["state"], "armed_pre_sale")
        self.assertEqual(next_action(result), "hold_same_session_and_count_down")

    def test_sale_more_than_thirty_minutes_away_is_not_armed(self):
        result = classify_snapshot(
            {"body": "COMING SOON", "url": "https://tickets.test/event", "title": "Fixture"},
            now=datetime(2026, 8, 24, 1, 0, tzinfo=timezone.utc),
            sale_open_at="2026-08-24T10:00:00+07:00",
        )
        self.assertEqual(result["state"], "pre_sale")

    def test_sale_entry(self):
        self.assertEqual(self.state("รายละเอียดการซื้อบัตร", controls=["Buy Now ซื้อบัตร"])["state"], "sale_entry")

    def test_purchase_instructions_without_visible_control_are_not_sale_entry(self):
        result = self.state("คลิกปุ่มซื้อบัตรในวันเปิดจำหน่าย")
        self.assertNotEqual(result["state"], "sale_entry")

    def test_queue_preserves_retry_after(self):
        result = self.state("You are in the buying queue. Status last updated", retry=17)
        self.assertEqual(result["state"], "queue")
        self.assertEqual(result["retry_after_seconds"], 17)
        self.assertEqual(next_action(result), "keep_same_session_and_wait_retry_after")

    def test_waiting_room_entry_is_not_active_queue(self):
        result = self.state("YOU ARE NOW IN THE ENTRY ZONE", controls=["Join waiting room"])
        self.assertEqual(result["state"], "waiting_room_entry")
        self.assertEqual(next_action(result), "join_waiting_room_once")

    def test_waiting_room_instructions_without_visible_control_are_not_entry(self):
        result = self.state("โปรดกดรอรับคิวซื้อบัตร 1 ชั่วโมงก่อนเปิดจำหน่าย")
        self.assertNotEqual(result["state"], "waiting_room_entry")

    def test_generic_waiting_room_copy_is_not_an_active_queue(self):
        result = self.state("Waiting room instructions: do not refresh this page")
        self.assertNotEqual(result["state"], "queue")

    def test_queue_position_requires_explicit_number(self):
        unknown = self.state("You are in the buying queue. Status last updated")
        numbered = self.state("You are in the buying queue. Queue position: 100")
        self.assertIsNone(unknown["queue_position"])
        self.assertFalse(unknown["queue_position_verified"])
        self.assertEqual(numbered["queue_position"], 100)
        self.assertTrue(numbered["queue_position_verified"])

    def test_server_outage_preserves_retry_after(self):
        result = self.state("Service unavailable", retry=12, status=503)
        self.assertEqual(result["state"], "server_unavailable")
        self.assertEqual(result["retry_after_seconds"], 12)
        self.assertEqual(next_action(result), "keep_same_session_and_wait_retry_after")

    def test_login_can_use_secure_credentials(self):
        result = self.state("เข้าสู่ระบบ รหัสผ่าน", url="https://event.example/user/signin.php")
        self.assertEqual(result["state"], "login")
        self.assertEqual(next_action(result), "fill_credentials_or_prompt_securely")

    def test_captcha_handoff(self):
        self.assertEqual(self.state("reCAPTCHA")["state"], "captcha_handoff")

    def test_otp_handoff(self):
        self.assertEqual(self.state("OTP รหัสยืนยัน")["state"], "otp_handoff")

    def test_reserved_selection(self):
        self.assertEqual(self.state("Seat map เลือกที่นั่ง", seat_controls=12)["state"], "ticket_selection")

    def test_instructional_seat_text_is_not_a_selection_page(self):
        self.assertNotEqual(self.state("อ่านข้อมูลผังที่นั่งและวิธีเลือกที่นั่ง จำนวนบัตร")["state"], "ticket_selection")

    def test_general_admission_selection(self):
        self.assertEqual(self.state("ขั้นตอนที่ 2/4 เลือกจำนวนบัตร General Admission", url="https://tickets.test/festival.php")["state"], "quantity_selection")

    def test_multiple_ticket_selection_state(self):
        checkpoint = self.state("Seat map เลือกที่นั่ง จำนวนบัตร 4", seat_controls=20)
        self.assertEqual(checkpoint["state"], "ticket_selection")

    def test_terms_page_is_not_mistaken_for_payment(self):
        checkpoint = self.state("เงื่อนไข ข้อตกลง Payment Methods QR PromptPay I accept the Terms", url="https://booking.test/verify_condition.php?query=927")
        self.assertEqual(checkpoint["state"], "terms_conditions")
        self.assertFalse(verified_payment_handoff(checkpoint))

    def test_zone_and_attendee_states_follow_real_paths(self):
        self.assertEqual(self.state("ขั้นตอนที่ 1/4 เลือกรอบ & โซนการแสดง", url="https://booking.test/zones.php?query=927")["state"], "zone_selection")
        self.assertEqual(self.state("กรุณากรอกรายละเอียด ชื่อ-นามสกุลบน Ticket", url="https://booking.test/enroll.php?k=test")["state"], "attendee_details")

    def test_payment_options_are_not_final_payment(self):
        checkpoint = self.state("ขั้นตอนที่ 3/4 เลือกวิธีการชำระเงิน QR", url="https://booking.test/paymentall.php?k=test")
        self.assertEqual(checkpoint["state"], "checkout_options")
        self.assertFalse(verified_payment_handoff(checkpoint))

    def test_server_close_sale_is_terminal(self):
        checkpoint = self.state("ขณะนี้ปิดจำหน่ายบัตรผ่านช่องทางออนไลน์", url="https://tickets.test/close-sale/?t=1")
        self.assertEqual(checkpoint["state"], "sale_closed")
        self.assertEqual(next_action(checkpoint), "stop_and_report_sale_closed")

    def test_adjacent_seats_require_consecutive_numbers(self):
        seats = [
            {"zone": "A", "row": "R1", "number": "1"},
            {"zone": "A", "row": "R1", "number": "2"},
            {"zone": "A", "row": "R1", "number": "4"},
        ]
        self.assertEqual(choose_seat_indices(seats, 2, "adjacent", ["A"]), [0, 1])
        self.assertEqual(choose_seat_indices(seats, 3, "adjacent", ["A"]), [])

    def test_same_zone_can_be_non_adjacent(self):
        seats = [
            {"zone": "A", "row": "R1", "number": "1"},
            {"zone": "A", "row": "R2", "number": "9"},
            {"zone": "B", "row": "R1", "number": "2"},
        ]
        self.assertEqual(choose_seat_indices(seats, 2, "same_zone", ["A"]), [0, 1])

    def test_any_seat_respects_zone_priority(self):
        seats = [
            {"zone": "B", "row": "R1", "number": "1"},
            {"zone": "A", "row": "R1", "number": "7"},
            {"zone": "A", "row": "R3", "number": "20"},
        ]
        self.assertEqual(choose_seat_indices(seats, 2, "any", ["A", "B"]), [1, 2])

    def test_any_seat_never_mixes_zones(self):
        seats = [
            {"zone": "A", "row": "R1", "number": "1"},
            {"zone": "B", "row": "R1", "number": "2"},
        ]
        self.assertEqual(choose_seat_indices(seats, 2, "any", ["A", "B"]), [])

    def test_exact_row_and_seat_number(self):
        seats = [
            {"zone": "A", "row": "J", "number": "10"},
            {"zone": "A", "row": "K", "number": "10"},
            {"zone": "A", "row": "K", "number": "11"},
        ]
        self.assertEqual(choose_seat_indices(seats, 1, "adjacent", ["A"], ["K"], ["10"], "exact"), [1])

    def test_nearest_number_stays_in_requested_zone(self):
        seats = [
            {"zone": "B", "row": "K", "number": "10"},
            {"zone": "A", "row": "K", "number": "8"},
            {"zone": "A", "row": "K", "number": "11"},
        ]
        self.assertEqual(choose_seat_indices(seats, 1, "adjacent", ["A"], ["K"], ["10"], "nearest"), [2])

    def test_requested_zone_is_never_silently_changed(self):
        seats = [{"zone": "B", "row": "K", "number": "10"}]
        self.assertEqual(choose_seat_indices(seats, 1, "any", ["A"], [], [], "zone_any"), [])

    def test_exact_mode_fails_when_requested_seat_is_missing(self):
        seats = [{"zone": "A", "row": "K", "number": "11"}]
        self.assertEqual(choose_seat_indices(seats, 1, "adjacent", ["A"], ["K"], ["10"], "exact"), [])

    def test_payment_is_verified_only_with_evidence(self):
        checkpoint = self.state("ขั้นตอนที่ 4/4 ชำระเงิน หมายเลขการสั่งซื้อ 2529889 PromptPay Remaining time: 590", url="https://booking.test/payment_kbankqr.php")
        self.assertEqual(checkpoint["state"], "payment_handoff")
        self.assertTrue(verified_payment_handoff(checkpoint))

    def test_generic_qr_copy_is_not_verified_checkout(self):
        checkpoint = self.state("Payment Methods include QR and PromptPay", url="https://tickets.test/conditions")
        self.assertNotEqual(checkpoint["state"], "payment_handoff")
        self.assertFalse(verified_payment_handoff(checkpoint))

    def test_unknown_is_never_checkout(self):
        checkpoint = self.state("หน้าแรกทั่วไป")
        self.assertEqual(checkpoint["state"], "unknown")
        self.assertFalse(verified_payment_handoff(checkpoint))


if __name__ == "__main__":
    unittest.main(verbosity=2)
'''

    start_script = '''#!/bin/zsh
set -euo pipefail
PROGRAM_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROGRAM_DIR"
PYTHON_BIN="${ALPHA_PYTHON_BIN:-$(command -v python3)}"
if [[ ! -x .venv/bin/python ]]; then "$PYTHON_BIN" -m venv .venv; fi
.venv/bin/python -m pip install --disable-pip-version-check -r requirements.txt
exec .venv/bin/python bot.py "$@"
'''
    full_loop_script = '''#!/bin/zsh
set -euo pipefail
PROGRAM_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROGRAM_DIR"
exec "$PROGRAM_DIR/start.command" --wait-for-window --confirm-order
'''
    readme = f'''# {project.name}

Evidence-backed Python + Playwright ticket assistant for **{event_name}**.

## Verification levels

- `verification-report.json`: local state-machine fixture results.
- `python3 bot.py --inspect-only`: read the live public page and write evidence without entering a purchase.
- `python3 bot.py --wait-for-window`: keep one Chrome session, enter the normal queue window, respect Retry-After, complete Login from environment/secure prompt, and stop only for CAPTCHA/OTP/payment handoff.
- `./run-full-loop.command`: run the verified browser loop through terms, zone, quantity, event-specific attendee fields, delivery/payment options, and stop on the generated QR page before payment.

Fixture verification does not mean a live queue or checkout was observed. `CHECKOUT_READY` is never emitted without payment-page evidence.

Public inspection does not require Login. A real run must verify either an existing member session or a successful Login-form transition before Checkout. Set `TICKET_USERNAME` and `TICKET_PASSWORD` in the Terminal session or enter them at the secure prompt; the password is never written to config, reports, or memory.

`preferredZones` may be empty when the zone map is not public yet. At runtime the bot reads A/A1/A2-style zones from the authenticated page and asks before selecting; it never silently chooses the first zone. `preferredRows`, `preferredSeatNumbers`, and `seatFallbackMode` control exact/nearest selection while keeping all tickets in the chosen zone.

## Start on macOS

Run `./start.command --inspect-only` first. For an event whose queue opens before sale, set `queueOpenAt` and `saleOpenAt` separately in `config.json`, then launch 10–15 minutes before `queueOpenAt`.
'''

    files = {
        "config.json": json.dumps(config, ensure_ascii=False, indent=2),
        "state_machine.py": state_machine,
        "bot.py": bot_source,
        "tests/test_state_machine.py": test_source,
        "requirements.txt": "playwright>=1.55,<2\n",
        "start.command": start_script,
        "run-full-loop.command": full_loop_script,
        "README.md": readme,
    }
    for relative, content in files.items():
        target = project / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    (project / "start.command").chmod(0o755)
    (project / "run-full-loop.command").chmod(0o755)
    # Build and verify on the container-local filesystem first. Docker Desktop
    # can make an external-volume write visible to macOS before a nested process
    # in the same container can reopen it.
    completed = subprocess.run(
        [sys.executable, str(project / "tests" / "test_state_machine.py")],
        cwd=project,
        text=True,
        capture_output=True,
        timeout=30,
    )
    for cache in project.rglob("__pycache__"):
        shutil.rmtree(cache, ignore_errors=True)
    test_count = completed.stdout.count(" ... ok") + completed.stderr.count(" ... ok")
    verification = {
        "fixture_tests_passed": completed.returncode == 0,
        "fixture_test_count": test_count,
        "queue_fixture_verified": completed.returncode == 0 and "test_queue_preserves_retry_after" in (completed.stdout + completed.stderr),
        "live_public_page_verified": bool(preflight.get("public_page_verified")),
        "live_queue_observed": False,
        "live_checkout_verified": False,
        "stdout": completed.stdout,
        "stderr": completed.stderr,
        "scope": "local deterministic fixtures plus public event-page facts when available; runtime discovery is required when the public detail page blocks inspection; no live purchase, queue, login or payment was attempted",
    }
    (project / "verification-report.json").write_text(json.dumps(verification, ensure_ascii=False, indent=2), encoding="utf-8")
    shutil.copytree(project, destination_project)
    shutil.rmtree(verification_root, ignore_errors=True)
    project = destination_project
    result.update({
        "generator_version": "1.1.0-beta.22",
        "status": "project_verified" if completed.returncode == 0 else "project_created_unverified",
        "next_action": "run_inspect_only_then_wait_for_queue_window" if completed.returncode == 0 else "repair_fixture_failures_before_live_run",
        "created_project_path": str(project),
        "created_files": [*files.keys(), "verification-report.json"],
        "fixture_verification": verification,
        "runtime_initial_status": "ready_to_build",
    })

output.joinpath("ticket-assistant-plan.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
output.joinpath("ticket-assistant-plan.md").write_text(
    f"# Concert ticket assistant\n\nStatus: {result['status']}\n\nMissing: {', '.join(result['missing_preferences']) or 'none'}\n",
    encoding="utf-8",
)
print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))

# alpha-beta22-visible-queue-evidence-v1

# alpha-beta21-ticket-runtime-v1
