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
selected_performance = payload.get("selected_performance") if isinstance(payload.get("selected_performance"), dict) else {}
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
        "generatorVersion": "2.0.0-alpha.1",
        "eventId": selected_id,
        "eventName": event_name,
        "eventUrl": event_url,
        "schedule": schedule,
        "selectedPerformance": {
            "schedule": str(selected_performance.get("schedule", ""))[:300],
            "label": str(selected_performance.get("label", ""))[:300],
            "contextText": str(selected_performance.get("context_text", ""))[:500],
            "selector": str(selected_performance.get("selector", ""))[:500],
            "dataButton": str(selected_performance.get("data_button", ""))[:120],
            "targetUrl": str(selected_performance.get("target_url", ""))[:2000],
            "productName": str(selected_performance.get("product_name", ""))[:160],
            "productType": str(selected_performance.get("product_type", ""))[:40],
            "status": str(selected_performance.get("status", ""))[:30],
        },
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
        "seatRecovery": {
            "mode": "until_terminal",
            "maxAttempts": 0,
            "zoneOrder": zones,
            "clickVerificationTimeoutMs": 2500,
            "inventoryRescanIntervalMs": 750,
            "seatMapReadyTimeoutMs": 12000,
            "conflictBlacklistTtlMs": 5000,
            "releasePartialBeforeRetry": True,
            "preserveGroupingRule": True,
        },
        "seatAvailability": {
            "enabled": seat_mode == "reserved",
            "sourcePolicy": "official_page_session",
            "minimumAvailable": quantity,
        },
        "manualIntervention": {
            "policy": "observe_then_resume",
            "idleResumeMs": 2000,
        },
        "autonomy": {
            "scope": "project",
            "transientRecovery": "automatic",
            "sourcePatchPromotion": "confirm",
        },
        "aiRuntime": {
            "enabled": True,
            "analyzeEveryState": True,
            "backgroundAdvisor": True,
            "actionMode": "validated_autonomous",
            "strategyMemory": True,
            "maxStrategyEntries": 200,
            "timeoutSeconds": 25,
            "keepAlive": "-1",
            "model": "alpha:9b",
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
    visible_sale_entry = bool(
        re.search(r"buy now|buy ticket|book now|purchase|checkout|ซื้อบัตร|จองบัตร", actionable_text)
        or (re.search(r"เลือกรอบ\s*/\s*ประเภทบัตร", actionable_text) and re.search(r"on\s*sale\s*now|เปิดจำหน่ายแล้ว|เปิดขายแล้ว", body))
    )
    # A lost browser is recoverable outside an active queue and must never be
    # misreported as a successful or unknown ticket state.
    if snapshot.get("browser_closed"):
        state, evidence = "browser_lost", ["ticket browser page or context closed unexpectedly"]
    # A visible human challenge wins over HTTP/queue markers. Queue providers
    # commonly serve CAPTCHA with 403/429/503 while preserving the same session.
    elif re.search(r"captcha|recaptcha|hcaptcha|ยืนยันว่า.*มนุษย์|verify\s+you\s+are\s+human|security\s+check", text):
        state, evidence = "captcha_handoff", ["captcha marker"]
    elif re.search(r"otp|one[ -]?time|รหัสยืนยัน", text):
        state, evidence = "otp_handoff", ["otp marker"]
    elif http_status in {429, 500, 502, 503, 504}:
        state, evidence = "server_unavailable", [f"http status {http_status}"]
    elif http_status in {401, 403} or re.search(r"access denied|you don'?t have permission to access|การเข้าถึงถูกปฏิเสธ", text):
        state, evidence = "access_denied", [f"server denied browser access ({http_status or 'page marker'})"]
    elif ("error.php" in url and "errcode=9" in url) or re.search(r"seat\s*hold\s*(?:expired|released)|reservation\s*(?:expired|lost)|หมดเวลาการจอง|ที่นั่ง.*(?:หลุด|ถูกปล่อย)|session\s*expired", body):
        state, evidence = "reservation_expired", ["server reports that the seat hold expired"]
    elif "close-sale" in url or re.search(r"ปิดจำหน่ายบัตรผ่านช่องทางออนไลน์|online\s+sale\s+is\s+closed", body):
        state, evidence = "sale_closed", ["server returned close-sale state"]
    elif re.search(r"ticket\s*status[\s\S]{0,120}sold\s*out|สถานะ(?:บัตร|การขาย)[\s\S]{0,120}(?:sold\s*out|บัตรหมด)|(?:^|\n)\s*sold\s*out\s*(?:$|\n)", body):
        state, evidence = "sold_out", ["server returned an explicit sold-out status"]
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
    elif "verify_condition.php" in url:
        state, evidence = "terms_conditions", ["event terms page"]
    elif "signin.php" in url or (re.search(r"เข้าสู่ระบบ|sign in", body) and re.search(r"รหัสผ่าน|password", body)):
        state, evidence = "login", ["login form"]
    # festival.php is a quantity/GA flow even though its heading can contain
    # the generic Thai phrase "เลือกที่นั่ง". URL precedence prevents it from
    # being sent into the reserved-seat canvas engine.
    elif "festival.php" in url or re.search(r"เลือกจำนวนบัตร", body):
        state, evidence = "quantity_selection", ["ticket quantity page"]
    elif "fixed.php" in url or re.search(r"ขั้นตอนที่\s*2/4[\s\S]{0,120}เลือกที่นั่ง", body):
        state, evidence = "ticket_selection", ["reserved seat map page"]
    elif "zones.php" in url or re.search(r"ขั้นตอนที่\s*1/4|เลือกโซน|select\s+(?:round|zone)", body):
        state, evidence = "zone_selection", ["round and zone page"]
    elif seat_control_count > 0:
        state, evidence = "ticket_selection", [f"visible selectable seat controls ({seat_control_count})"]
    elif visible_sale_entry:
        state, evidence = "sale_entry", ["visible sale entry on an on-sale page"]
    elif re.search(r"conditions|เงื่อนไข\s*ข้อตกลง|i accept the terms", body):
        state, evidence = "terms_conditions", ["event terms page"]
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
        "actionable_labels": [str(item.get("label", "") if isinstance(item, dict) else item)[:160] for item in (snapshot.get("actionable_controls", []) or [])[:40]],
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
        "access_denied": "keep_same_session_and_retry_adaptively",
        "reservation_expired": "return_to_same_seat_map_and_recover",
        "sale_closed": "stop_and_report_sale_closed",
        "sold_out": "stop_and_report_sold_out",
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
        "browser_lost": "relaunch_same_profile_and_resume",
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


def expand_zone_preferences(values):
    """Expand user-friendly zone ranges while preserving the requested order."""
    expanded = []
    for value in values or []:
        text = str(value).strip().upper()
        match = re.fullmatch(r"([A-Z])\s*-\s*([A-Z])", text)
        if match:
            start, end = ord(match.group(1)), ord(match.group(2))
            step = 1 if start <= end else -1
            expanded.extend(chr(code) for code in range(start, end + step, step))
        elif text:
            expanded.append(text)
    return list(dict.fromkeys(expanded))


def choose_seat_indices(seats, quantity, grouping="adjacent", preferred_zones=None, preferred_rows=None, preferred_numbers=None, fallback_mode="nearest"):
    wanted = max(1, int(quantity))
    zones = expand_zone_preferences(preferred_zones)
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
import atexit
import base64
import getpass
import hashlib
import json
import os
import pathlib
import re
import select
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from state_machine import choose_seat_indices, classify_snapshot, expand_zone_preferences, next_action, verified_payment_handoff

ROOT = Path(__file__).resolve().parent
CONFIG = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
REPORT = ROOT / "run-report.jsonl"
ACTIONABLE_SELECTOR = "button, a[href], area[href], input[type=button], input[type=submit], input[type=image], [role=button], [role=link], [onclick]"
SEAT_SELECTOR = ".seatuncheck, .seatcheck, [data-seat][data-seatk], [data-seat][data-available='true'], [data-seat][data-status='available'], [data-seat-number], [role='button'][aria-label*='seat' i]"
SELECTED_SEAT_SELECTOR = ".seatcheck, .seat-selected, .selected-seat, [data-seat][data-selected='true'], [data-seat][data-status='selected'], [aria-pressed='true'][aria-label*='seat' i], input[data-seat]:checked"
OWNED_BROWSER_PROCESS = None
LATEST_RESERVATION_RESPONSE = {"status": None, "url": "", "body": "", "at": 0.0}
RESERVATION_RESPONSE_HISTORY = []
LATEST_ZONE_AVAILABILITY_RESPONSE = {"zones": {}, "url": "", "at": 0.0}
SEAT_CONFLICT_BLACKLIST = {}
SEAT_CONFLICT_GENERATION = {}
NAVIGATION_STATE = {"generation": 0, "last_url": "", "last_event_at": 0.0, "closed": False}
NAVIGATION_LOCK = threading.RLock()
OBSERVED_PAGE_IDS = set()
ACTIVE_RUNTIME_PAGE = {"page": None}
RUNTIME_HEARTBEAT_STARTED = False
RUNTIME_HEARTBEAT_CACHE = {"browser_connected": False, "url": "", "navigation_generation": 0}
AI_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="alpha-ticket-ai")
AI_INCIDENT_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="alpha-ticket-incident-ai")
AI_FUTURES = {}
AI_LOCK = threading.RLock()
REPORT_LOCK = threading.RLock()
AI_LAST_DECISION = {}
AI_LAST_DECISIONS = {}
AI_LAST_DECISIONS_BY_STATE = {}
AI_LAST_STATE = ""
AI_LAST_SUBMITTED = {}
AI_LAST_STATE_SUBMITTED = {}
AI_ACTION_LAST_EXECUTED = {}
AI_STRATEGY_PATH = Path(os.environ.get("ALPHA_TICKET_STRATEGY_PATH") or (ROOT.parent.parent / "work" / "ticket-ai-recovery-strategies.json"))


def record(kind, payload):
    item = {"at": datetime.now().astimezone().isoformat(), "kind": kind, **payload}
    with REPORT_LOCK:
        with REPORT.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(item, ensure_ascii=False) + "\n")
        print(json.dumps(item, ensure_ascii=False), flush=True)


def start_runtime_heartbeat(page):
    global RUNTIME_HEARTBEAT_STARTED
    ACTIVE_RUNTIME_PAGE["page"] = page
    update_runtime_heartbeat_cache(page)
    with NAVIGATION_LOCK:
        if RUNTIME_HEARTBEAT_STARTED:
            return None
        RUNTIME_HEARTBEAT_STARTED = True

    def heartbeat_loop():
        sequence = 0
        while True:
            sequence += 1
            # Playwright's sync API is thread-bound. The heartbeat thread must
            # only publish values copied by the main browser thread; touching a
            # Page here raises greenlet.error and can deadlock the whole run.
            with NAVIGATION_LOCK:
                cached = dict(RUNTIME_HEARTBEAT_CACHE)
            record("runtime_heartbeat", {
                "sequence": sequence,
                "process_alive": True,
                "browser_connected": cached.get("browser_connected", False),
                "url": cached.get("url", ""),
                "navigation_generation": cached.get("navigation_generation", 0),
                "ai_ready": bool((CONFIG.get("aiRuntime") or {}).get("enabled", True)),
                "ai_mode": "standby",
            })
            time.sleep(5)
    thread = threading.Thread(target=heartbeat_loop, name="alpha-ticket-heartbeat", daemon=True)
    thread.start()
    return thread


def page_is_alive(page):
    try:
        return page is not None and not page.is_closed()
    except Exception:
        return False


def safe_page_url(page, fallback=""):
    if not page_is_alive(page):
        return str(fallback or "")
    try:
        return str(page.url or fallback or "")
    except Exception:
        return str(fallback or "")


def update_runtime_heartbeat_cache(page):
    """Copy browser state on the Playwright/main thread for heartbeat readers."""
    connected = page_is_alive(page)
    url = safe_page_url(page) if connected else ""
    with NAVIGATION_LOCK:
        RUNTIME_HEARTBEAT_CACHE["browser_connected"] = connected
        RUNTIME_HEARTBEAT_CACHE["url"] = url
        RUNTIME_HEARTBEAT_CACHE["navigation_generation"] = int(NAVIGATION_STATE.get("generation", 0))


def bind_navigation_observer(page):
    """Track page/frame changes without taking over the user's mouse."""
    ACTIVE_RUNTIME_PAGE["page"] = page
    page_id = id(page)
    with NAVIGATION_LOCK:
        if page_id in OBSERVED_PAGE_IDS:
            return
        OBSERVED_PAGE_IDS.add(page_id)

    def changed(frame=None):
        with NAVIGATION_LOCK:
            NAVIGATION_STATE["generation"] = int(NAVIGATION_STATE.get("generation", 0)) + 1
            NAVIGATION_STATE["last_url"] = safe_page_url(page, NAVIGATION_STATE.get("last_url", ""))
            NAVIGATION_STATE["last_event_at"] = time.monotonic()
            NAVIGATION_STATE["closed"] = not page_is_alive(page)
        update_runtime_heartbeat_cache(page)

    try:
        page.on("framenavigated", changed)
        page.on("popup", lambda popup: changed())
        page.on("close", lambda: changed())
    except Exception:
        pass
    try:
        page.add_init_script("""
          (() => {
            if (window.__alphaRuntimeObserverInstalled) return;
            window.__alphaRuntimeObserverInstalled = true;
            window.__alphaLastUserInputAt = 0;
            window.__alphaDomGeneration = 0;
            const mark = event => {
              if (event && event.isTrusted) window.__alphaLastUserInputAt = Date.now();
            };
            for (const name of ['pointerdown', 'mousedown', 'touchstart', 'keydown', 'wheel']) {
              addEventListener(name, mark, {capture: true, passive: true});
            }
            new MutationObserver(records => {
              if (records.some(record => record.type === 'childList' && record.target === document.documentElement)) {
                window.__alphaDomGeneration += 1;
              }
            }).observe(document.documentElement, {childList: true, subtree: false});
          })();
        """)
    except Exception:
        pass
    changed()


def navigation_marker(page):
    with NAVIGATION_LOCK:
        generation = int(NAVIGATION_STATE.get("generation", 0))
    marker = {"generation": generation, "url": safe_page_url(page), "dom_generation": 0, "last_user_input_at": 0}
    if not page_is_alive(page):
        return marker
    try:
        browser_values = page.evaluate("""() => ({
          domGeneration: Number(window.__alphaDomGeneration || 0),
          lastUserInputAt: Number(window.__alphaLastUserInputAt || 0),
        })""")
        marker["dom_generation"] = int(browser_values.get("domGeneration") or 0)
        marker["last_user_input_at"] = int(browser_values.get("lastUserInputAt") or 0)
    except Exception:
        pass
    return marker


def wait_for_manual_idle(page, previous_state, current_state):
    settings = CONFIG.get("manualIntervention") if isinstance(CONFIG.get("manualIntervention"), dict) else {}
    idle_ms = max(250, int(settings.get("idleResumeMs", 2000) or 2000))
    record("navigation_interrupt", {
        "from_state": previous_state,
        "to_state": current_state,
        "url": safe_page_url(page),
        "navigation_generation": navigation_marker(page).get("generation"),
        "old_task_cancelled": True,
    })
    announced = False
    # A navigation can replace the document and reset the browser-side input
    # timestamp. Always preserve a full quiet window after the interruption,
    # then extend it whenever a new trusted user interaction is observed.
    quiet_deadline = time.monotonic() + idle_ms / 1000
    latest_input_at = 0
    while page_is_alive(page):
        marker = navigation_marker(page)
        browser_input_at = int(marker.get("last_user_input_at") or 0)
        if browser_input_at > latest_input_at:
            latest_input_at = browser_input_at
            quiet_deadline = time.monotonic() + idle_ms / 1000
        remaining = quiet_deadline - time.monotonic()
        if remaining <= 0:
            break
        if not announced:
            record("manual_control", {"active": True, "policy": "observe_then_resume", "idle_resume_ms": idle_ms})
            announced = True
        time.sleep(min(0.1, max(0.02, remaining)))
    if announced:
        record("manual_control", {"active": False, "policy": "observe_then_resume"})
    record("state_resumed", {"state": current_state, "url": safe_page_url(page), "preserved_preferences": True})
    return current_state


def console_input(prompt=""):
    """Keep operator prompts off stdout so JSON runtime events stay parseable."""
    if prompt:
        try:
            print(prompt, file=sys.stderr, flush=True)
        except (BlockingIOError, OSError):
            # The manager already received an input_required event. A saturated
            # stderr pipe must never terminate the ticket process.
            pass
    value = sys.stdin.readline()
    return value.rstrip("\r\n") if value else ""


def capture_status_evidence(page, status):
    evidence_dir = Path(os.environ.get("ALPHA_TICKET_EVIDENCE_DIR") or (ROOT / "evidence"))
    evidence_dir.mkdir(parents=True, exist_ok=True)
    safe_status = re.sub(r"[^a-z0-9_-]+", "-", str(status).casefold()).strip("-") or "status"
    destination = evidence_dir / f"{datetime.now().astimezone().strftime('%Y%m%d-%H%M%S')}-{safe_status}.png"
    try:
        page.screenshot(path=str(destination), full_page=True)
        record("evidence", {"status": status, "path": str(destination), "url": safe_page_url(page), "evidence_type": "screenshot"})
        return str(destination)
    except Exception as error:
        record("evidence_error", {"status": status, "error": str(error)[:500], "url": safe_page_url(page)})
        return ""


def stop_owned_browser():
    global OWNED_BROWSER_PROCESS
    process = OWNED_BROWSER_PROCESS
    OWNED_BROWSER_PROCESS = None
    if not process or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=3)


atexit.register(stop_owned_browser)


def launch_ticket_browser(runtime, browser_profile):
    """Launch a normal Chrome process, then attach Playwright over local CDP.

    This avoids Playwright's automation launch-argument bundle, which the live
    ticket site rejects with 403, while keeping an isolated persistent profile.
    """
    global OWNED_BROWSER_PROCESS
    executable = Path(runtime.chromium.executable_path)
    if not executable.is_file():
        raise RuntimeError(f"Chrome for Testing is not installed: {executable}")
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as port_socket:
        port_socket.bind(("127.0.0.1", 0))
        cdp_port = int(port_socket.getsockname()[1])
    command = [
        str(executable),
        f"--user-data-dir={Path(browser_profile).resolve()}",
        f"--remote-debugging-port={cdp_port}",
        "--remote-debugging-address=127.0.0.1",
        "--no-first-run",
        "--new-window",
        "about:blank",
    ]
    OWNED_BROWSER_PROCESS = subprocess.Popen(
        command,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    endpoint = f"http://127.0.0.1:{cdp_port}"
    last_error = None
    for _ in range(100):
        if OWNED_BROWSER_PROCESS.poll() is not None:
            raise RuntimeError(f"Chrome exited before CDP became ready (exit {OWNED_BROWSER_PROCESS.returncode})")
        try:
            with urllib.request.urlopen(endpoint + "/json/version", timeout=0.25):
                break
        except Exception as error:
            last_error = error
            time.sleep(0.1)
    else:
        stop_owned_browser()
        raise RuntimeError(f"Chrome CDP did not become ready: {last_error}")
    browser = runtime.chromium.connect_over_cdp(endpoint)
    if not browser.contexts:
        stop_owned_browser()
        raise RuntimeError("Chrome CDP returned no browser context")
    return browser, browser.contexts[0], cdp_port


def ticket_browser_pid(browser_profile):
    """Return the top-level Chrome PID that owns this run's isolated profile."""
    marker = f"--user-data-dir={Path(browser_profile).resolve()}"
    try:
        completed = subprocess.run(
            ["/bin/ps", "-axo", "pid=,command="],
            text=True,
            capture_output=True,
            timeout=5,
            check=False,
        )
    except Exception:
        return None
    for line in completed.stdout.splitlines():
        if marker not in line or ".app/Contents/MacOS/Google Chrome" not in line:
            continue
        try:
            return int(line.strip().split(None, 1)[0])
        except (TypeError, ValueError, IndexError):
            continue
    return None


def surface_browser_window(page, browser_profile, stage):
    """Show the exact ticket-run Chrome window without moving the system mouse."""
    page_front = False
    try:
        page.bring_to_front()
        page_front = True
    except Exception:
        pass
    browser_pid = ticket_browser_pid(browser_profile)
    activated = False
    detail = ""
    if sys.platform == "darwin" and browser_pid:
        swift_source = (
            "import AppKit\n"
            "import ApplicationServices\n"
            f"let pid = pid_t({int(browser_pid)})\n"
            "var appActivated = false\n"
            "var windowRaised = false\n"
            "var axResult = AXError.failure\n"
            "if let app = NSRunningApplication(processIdentifier: pid) {\n"
            "  app.unhide()\n"
            "  appActivated = app.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])\n"
            "}\n"
            "let appElement = AXUIElementCreateApplication(pid)\n"
            "AXUIElementSetAttributeValue(appElement, kAXFrontmostAttribute as CFString, kCFBooleanTrue)\n"
            "var windowValue: CFTypeRef?\n"
            "axResult = AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &windowValue)\n"
            "if axResult == .success, let windows = windowValue as? [AXUIElement] {\n"
            "  for window in windows {\n"
            "    AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)\n"
            "    AXUIElementSetAttributeValue(window, kAXFocusedAttribute as CFString, kCFBooleanTrue)\n"
            "    if AXUIElementPerformAction(window, kAXRaiseAction as CFString) == .success {\n"
            "      windowRaised = true\n"
            "      break\n"
            "    }\n"
            "  }\n"
            "}\n"
            "print(\"app=\\(appActivated);window=\\(windowRaised);ax=\\(axResult.rawValue)\")\n"
        )
        try:
            completed = subprocess.run(
                ["/usr/bin/swift", "-e", swift_source],
                text=True,
                capture_output=True,
                timeout=12,
                check=False,
            )
            swift_output = completed.stdout.strip()
            activated = completed.returncode == 0 and "app=true" in swift_output.lower()
            window_raised = completed.returncode == 0 and "window=true" in swift_output.lower()
            detail_parts = [swift_output]
            if completed.stderr.strip():
                detail_parts.append(completed.stderr.strip()[-500:])
            detail = " | ".join(part for part in detail_parts if part)[-800:]
        except Exception as error:
            detail = str(error)[:500]
            window_raised = False
    else:
        window_raised = False
    record("browser_window", {
        "stage": stage,
        "browser_pid": browser_pid,
        "page_brought_to_front": page_front,
        "app_activated": activated,
        "window_raised": window_raised,
        "mouse_control": False,
        "detail": detail,
    })
    return page_front and (window_raised or activated or sys.platform != "darwin")


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
            total += int(scope.locator(SEAT_SELECTOR).evaluate_all("""elements => elements.slice(0, 1000).filter(element => {
              const style = getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0
                && style.display !== 'none' && style.visibility !== 'hidden'
                && Number(style.opacity || 1) > 0
                && !element.disabled
                && (element.getAttribute('aria-disabled') || '').toLowerCase() !== 'true';
            }).length"""))
        except Exception:
            continue
    return total


def wait_for_seat_controls(page, timeout_ms=12000):
    count = visible_seat_control_count(page)
    if not count:
        deadline = time.monotonic() + max(0, timeout_ms) / 1000
        for scope in [page, *[frame for frame in page.frames if frame != page.main_frame]]:
            remaining_ms = max(1, int((deadline - time.monotonic()) * 1000))
            if remaining_ms <= 1:
                break
            try:
                scope.locator(SEAT_SELECTOR).first.wait_for(state="visible", timeout=remaining_ms)
                break
            except Exception:
                continue
        count = visible_seat_control_count(page)
    if count:
        record("seat_map", {"status": "READY", "visible_seat_control_count": count, "frame_urls": [frame.url for frame in page.frames if frame != page.main_frame]})
        return count
    record("seat_map", {"status": "CONTROLS_NOT_FOUND", "visible_seat_control_count": 0, "frame_urls": [frame.url for frame in page.frames if frame != page.main_frame]})
    return 0


def wait_for_page_change(page, previous_url, timeout_ms=5000):
    """Wait for navigation or a DOM mutation; do not insert a fixed checkout sleep."""
    try:
        page.wait_for_function("before => location.href !== before", arg=previous_url, timeout=timeout_ms)
        return "navigation"
    except Exception:
        pass
    try:
        return page.evaluate("""timeout => new Promise(resolve => {
          const observer = new MutationObserver(() => { observer.disconnect(); resolve('mutation'); });
          observer.observe(document.documentElement, {subtree: true, childList: true, attributes: true});
          setTimeout(() => { observer.disconnect(); resolve('timeout'); }, timeout);
        })""", min(1500, max(100, timeout_ms)))
    except Exception:
        return "unavailable"


def wait_for_inventory_change(page, timeout_ms):
    """Use DOM mutation notifications between rescans instead of sleeping blindly."""
    observed = False
    deadline = time.monotonic() + max(100, int(timeout_ms)) / 1000
    for scope in [page, *[frame for frame in page.frames if frame != page.main_frame]]:
        remaining_ms = max(0, int((deadline - time.monotonic()) * 1000))
        if remaining_ms <= 0:
            break
        try:
            result = scope.evaluate("""timeout => new Promise(resolve => {
              const root = document.querySelector('[data-seat], .seatuncheck, .seatcheck, area') || document.body;
              if (!root) { resolve(false); return; }
              const observer = new MutationObserver(() => { observer.disconnect(); resolve(true); });
              observer.observe(root, {subtree: true, childList: true, attributes: true});
              setTimeout(() => { observer.disconnect(); resolve(false); }, timeout);
            })""", remaining_ms)
            observed = observed or bool(result)
            if observed:
                break
        except Exception:
            continue
    return observed


def wait_for_seat_dom_quiet(page, quiet_ms=250, timeout_ms=2500):
    """Wait until the live seat DOM has had a mutation-free quiet window.

    This is driven by MutationObserver and only uses the timer as a bounded
    quiet-window/deadline. It does not add a blind fixed sleep to the critical
    path.
    """
    deadline = time.monotonic() + max(100, int(timeout_ms)) / 1000
    scopes = [page, *[frame for frame in page.frames if frame != page.main_frame]]
    relevant_scopes = []
    for scope in scopes:
        try:
            if scope.locator(SEAT_SELECTOR).count():
                relevant_scopes.append(scope)
        except Exception:
            continue
    for scope in relevant_scopes or scopes[:1]:
        remaining_ms = max(1, int((deadline - time.monotonic()) * 1000))
        if remaining_ms <= 1:
            return False
        try:
            stable = scope.evaluate("""args => new Promise(resolve => {
              const root = document.querySelector('[data-seat], .seatuncheck, .seatcheck, area')?.parentElement || document.body;
              if (!root) { resolve(false); return; }
              let quietTimer;
              const finish = value => {
                clearTimeout(quietTimer);
                clearTimeout(deadlineTimer);
                observer.disconnect();
                resolve(value);
              };
              const armQuietWindow = () => {
                clearTimeout(quietTimer);
                quietTimer = setTimeout(() => finish(true), args.quietMs);
              };
              const observer = new MutationObserver(armQuietWindow);
              observer.observe(root, {subtree: true, childList: true, attributes: true});
              const deadlineTimer = setTimeout(() => finish(false), args.timeoutMs);
              armQuietWindow();
            })""", {"quietMs": max(100, int(quiet_ms)), "timeoutMs": remaining_ms})
            if not stable:
                return False
        except Exception:
            return False
    return True


def seat_inventory_fingerprint(metadata):
    normalized = sorted(
        (
            str(item.get("label") or ""),
            bool(item.get("available")),
            bool(item.get("selected")),
        )
        for item in metadata
        if item.get("visible", True)
    )
    return hashlib.sha256(json.dumps(normalized, ensure_ascii=False).encode("utf-8")).hexdigest()[:20]


def wait_for_stable_seat_inventory(page, fallback_zone="", timeout_ms=12000):
    """Prove the seat page is usable before allowing the first seat click."""
    started_at = time.monotonic()
    deadline = started_at + max(500, int(timeout_ms)) / 1000
    last_fingerprint = ""
    stable_rounds = 0
    record("seat_map_loading", {
        "status": "WAITING_FOR_STABLE_INVENTORY",
        "url": safe_page_url(page),
        "navigation_generation": navigation_marker(page).get("generation"),
        "terminal": False,
    })
    try:
        page.wait_for_load_state("domcontentloaded", timeout=min(max(1, int(timeout_ms)), 5000))
    except Exception:
        pass
    while time.monotonic() < deadline:
        if not page_is_alive(page):
            return {"ready": False, "state": "browser_lost", "reason": "page_closed"}
        current_url = safe_page_url(page)
        if "fixed.php" not in current_url.casefold():
            changed = classify_snapshot(snapshot(page), sale_open_at=CONFIG.get("saleOpenAt", ""))
            if changed.get("state") != "ticket_selection":
                return {"ready": False, "state": changed.get("state", "unknown"), "reason": "state_changed"}
        metadata, locators, scopes = collect_seat_inventory(page, fallback_zone)
        visible_count = sum(1 for item in metadata if item.get("visible", True))
        if visible_count and locators:
            fingerprint = seat_inventory_fingerprint(metadata)
            if fingerprint == last_fingerprint:
                stable_rounds += 1
            else:
                last_fingerprint = fingerprint
                stable_rounds = 1
            if stable_rounds >= 2:
                marker = navigation_marker(page)
                elapsed_ms = int((time.monotonic() - started_at) * 1000)
                record("seat_map_ready", {
                    "status": "STABLE_INVENTORY_READY",
                    "visible_seat_control_count": visible_count,
                    "candidate_count": len(metadata),
                    "available_count": sum(1 for item in metadata if item.get("available")),
                    "inventory_fingerprint": fingerprint,
                    "navigation_generation": marker.get("generation"),
                    "dom_generation": marker.get("dom_generation"),
                    "load_elapsed_ms": elapsed_ms,
                    "url": current_url,
                })
                return {"ready": True, "state": "ticket_selection", "metadata": metadata, "marker": marker, "fingerprint": fingerprint}
            remaining_ms = max(1, int((deadline - time.monotonic()) * 1000))
            wait_for_seat_dom_quiet(page, quiet_ms=250, timeout_ms=min(2000, remaining_ms))
            continue
        remaining_ms = max(1, int((deadline - time.monotonic()) * 1000))
        wait_for_inventory_change(page, min(1000, remaining_ms))
    marker = navigation_marker(page)
    record("seat_map_loading", {
        "status": "STABLE_INVENTORY_TIMEOUT",
        "url": safe_page_url(page),
        "navigation_generation": marker.get("generation"),
        "dom_generation": marker.get("dom_generation"),
        "terminal": False,
        "next_action": "preserve_page_and_rescan",
    })
    return {"ready": False, "state": "ticket_selection", "reason": "stable_inventory_timeout", "marker": marker}


def snapshot(page, retry_after_seconds=None, http_status=None, server_date=None):
    if not page_is_alive(page):
        return {
            "url": safe_page_url(page),
            "title": "",
            "body": "",
            "frame_urls": [],
            "retry_after_seconds": retry_after_seconds,
            "http_status": http_status,
            "server_date": server_date,
            "actionable_controls": [],
            "seat_control_count": 0,
            "browser_closed": True,
        }
    bodies = []
    frame_urls = []
    try:
        frames = list(page.frames)
    except Exception:
        frames = []
    for frame in frames:
        if frame != page.main_frame:
            try:
                owner = frame.frame_element()
                if not owner.is_visible(timeout=200):
                    continue
            except Exception:
                continue
        try:
            bodies.append(frame.locator("body").inner_text(timeout=2500))
            frame_urls.append(frame.url)
        except Exception:
            pass
    try:
        title = page.title()
    except Exception:
        title = ""
    return {
        "url": safe_page_url(page),
        "title": title,
        "body": "\n".join(bodies),
        "frame_urls": frame_urls,
        "retry_after_seconds": retry_after_seconds,
        "http_status": http_status,
        "server_date": server_date,
        "actionable_controls": visible_actionable_controls(page),
        "seat_control_count": visible_seat_control_count(page),
        "visible_dialogs": visible_runtime_dialogs(page),
        "browser_closed": not page_is_alive(page),
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


def _performance_match_text(value):
    return re.sub(r"\s+", " ", re.sub(r"(?:ซื้อบัตร|จองบัตร|buy\s*(?:now|ticket))\s*$", "", str(value or ""), flags=re.I)).strip()


def _usable_ticket_page(candidate):
    try:
        url = str(candidate.url or "")
        return not candidate.is_closed() and bool(url) and not url.startswith(("about:blank", "chrome-error://"))
    except Exception:
        return False


def page_after_ticket_navigation(current_page, pages_before):
    """Follow a booking popup/new tab and reject Chrome's internal error page."""
    context = current_page.context
    before_ids = {id(item) for item in pages_before}
    for _ in range(15):
        candidates = list(context.pages)
        for candidate in reversed(candidates):
            if id(candidate) not in before_ids and _usable_ticket_page(candidate):
                candidate.bring_to_front()
                record("navigation", {"status": "FOLLOWED_NEW_BOOKING_PAGE", "url": candidate.url, "same_session": True})
                return candidate
        if _usable_ticket_page(current_page):
            return current_page
        time.sleep(0.1)
    for candidate in reversed(list(context.pages)):
        if _usable_ticket_page(candidate):
            candidate.bring_to_front()
            record("navigation", {"status": "RECOVERED_EXISTING_BOOKING_PAGE", "url": candidate.url, "same_session": True})
            return candidate
    record("navigation", {"status": "NO_USABLE_BOOKING_PAGE", "url": str(getattr(current_page, "url", "")), "same_session": True})
    return None


def activate_selected_performance(page, prefer_target_navigation=False):
    selected = CONFIG.get("selectedPerformance") if isinstance(CONFIG.get("selectedPerformance"), dict) else {}
    if not selected:
        pages_before = list(page.context.pages)
        return page_after_ticket_navigation(page, pages_before) if semantic_click(page, sale_entry_labels()) else None

    selector = str(selected.get("selector", "")).strip()
    target_url = str(selected.get("targetUrl", "")).strip()
    current_host = urlsplit(page.url).netloc.casefold()
    event_host = urlsplit(str(CONFIG.get("eventUrl", ""))).netloc.casefold()
    if prefer_target_navigation and target_url.startswith(("https://", "http://")) and current_host == event_host and page.url != target_url:
        page.goto(target_url, wait_until="domcontentloaded", timeout=45000)
        record("action", {"action": "navigate_selected_booking_target", "url": target_url.split("?", 1)[0], "schedule": selected.get("schedule"), "same_queue_session": True, "reason": "verified_target_avoids_javascript_popup"})
        return page
    wanted_context = _performance_match_text(selected.get("contextText") or selected.get("label") or selected.get("schedule"))
    wanted_time = re.search(r"\b\d{1,2}:\d{2}\b", wanted_context or str(selected.get("schedule", "")))
    wanted_date = re.search(r"(?:วัน[^\s-]{0,16}ที่\s*)?\d{1,2}\s+(?:มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม)\s+\d{4}", wanted_context)

    def click_exact_control():
        if selector:
            try:
                locator = page.locator(selector).first
                if locator.count() and locator.is_enabled(timeout=500):
                    locator.scroll_into_view_if_needed(timeout=1000)
                    if locator.is_visible(timeout=500):
                        pages_before = list(page.context.pages)
                        locator.click()
                        record("action", {"action": "select_announced_performance", "selector": selector, "schedule": selected.get("schedule"), "label": selected.get("label"), "same_queue_session": True})
                        return page_after_ticket_navigation(page, pages_before)
            except Exception:
                pass
        for scope in [page, *page.frames]:
            controls = scope.locator("a[data-button], button[data-button], .box-event-list .row a, .box-event-list .row button")
            try:
                count = min(controls.count(), 100)
            except Exception:
                continue
            for index in range(count):
                control = controls.nth(index)
                try:
                    if not control.is_enabled(timeout=150):
                        continue
                    row_text = _performance_match_text(control.evaluate("element => (element.closest('.row,tr,li') || element).textContent || ''"))
                    date_ok = not wanted_date or wanted_date.group(0) in row_text
                    time_ok = not wanted_time or wanted_time.group(0) in row_text
                    if date_ok and time_ok and (wanted_date or wanted_time):
                        control.scroll_into_view_if_needed(timeout=1000)
                        if control.is_visible(timeout=500):
                            pages_before = list(page.context.pages)
                            control.click()
                            record("action", {"action": "select_announced_performance", "schedule": selected.get("schedule"), "matched_row": row_text[:300], "same_queue_session": True})
                            return page_after_ticket_navigation(page, pages_before)
                except Exception:
                    pass
        return False

    clicked_page = click_exact_control()
    if clicked_page:
        return clicked_page
    try:
        reveal = page.get_by_role("link", name=re.compile(r"เลือกรอบ\s*/\s*ประเภทบัตร", re.I)).first
        if reveal.count() and reveal.is_visible(timeout=500) and reveal.is_enabled(timeout=500):
            reveal.click()
            page.wait_for_timeout(400)
            clicked_page = click_exact_control()
            if clicked_page:
                return clicked_page
    except Exception:
        pass
    if target_url.startswith(("https://", "http://")) and current_host == event_host and page.url != target_url:
        page.goto(target_url, wait_until="domcontentloaded", timeout=45000)
        record("action", {"action": "navigate_selected_booking_target", "url": target_url.split("?", 1)[0], "schedule": selected.get("schedule"), "same_queue_session": True})
        return page
    return None


def ensure_locked_performance_on_booking_page(page):
    """Re-apply the locked show when a booking page asks for it again.

    Some events expose a second date/time selector after login or terms. The
    public event selector cannot be reused there, so match the locked schedule
    against the visible native select without changing event/date/time.
    """
    selected = CONFIG.get("selectedPerformance") if isinstance(CONFIG.get("selectedPerformance"), dict) else {}
    source = " ".join(str(selected.get(key, "")) for key in ("schedule", "label", "contextText"))
    source = f"{source} {CONFIG.get('schedule', '')}".strip()
    wanted_time_match = re.search(r"T(\d{1,2}:\d{2})(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?", source) or re.search(r"\b(\d{1,2}:\d{2})\b", source)
    wanted_time = wanted_time_match.group(1) if wanted_time_match else ""
    iso_date = re.search(r"\b(\d{4})-(\d{2})-(\d{2})(?=T|$)", source)
    date_tokens = set()
    if iso_date:
        year, month, day = (int(iso_date.group(1)), int(iso_date.group(2)), int(iso_date.group(3)))
        english_months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        date_tokens.update({
            f"{year:04d}-{month:02d}-{day:02d}",
            f"{day:02d}/{month:02d}/{year:04d}",
            f"{day}/{month}/{year}",
            f"{day:02d}/{month:02d}/{year + 543:04d}",
            f"{day}/{month}/{year + 543}",
            f"{day:02d} {english_months[month - 1]} {year:04d}",
            f"{english_months[month - 1]} {day:02d} {year:04d}",
        })
    thai_date = re.search(r"\d{1,2}\s+(?:มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม)\s+\d{4}", source)
    if thai_date:
        date_tokens.add(_performance_match_text(thai_date.group(0)).casefold())
    english_date = re.search(r"\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})\b", source, re.I)
    if english_date:
        english_months = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}
        day, month_name, year = int(english_date.group(1)), english_date.group(2)[:3].casefold(), int(english_date.group(3))
        month = english_months.get(month_name)
        if month:
            date_tokens.update({
                f"{year:04d}-{month:02d}-{day:02d}",
                f"{day:02d} {month_name.title()} {year:04d}",
                f"{month_name.title()} {day:02d} {year:04d}",
            })
    if not wanted_time and not date_tokens:
        return "absent"

    repeat_selector_seen = False
    for scope in [page, *[frame for frame in page.frames if frame != page.main_frame]]:
        selects = scope.locator("select")
        try:
            select_count = min(selects.count(), 40)
        except Exception:
            continue
        for select_index in range(select_count):
            control = selects.nth(select_index)
            try:
                if not control.is_visible(timeout=200) or not control.is_enabled(timeout=200):
                    continue
                descriptor = field_descriptor(control).casefold()
                options = control.locator("option")
                option_count = min(options.count(), 100)
                option_rows = []
                for option_index in range(option_count):
                    option = options.nth(option_index)
                    option_rows.append({
                        "index": option_index,
                        "text": _performance_match_text(option.inner_text(timeout=150)),
                    })
                option_text = " ".join(item["text"] for item in option_rows).casefold()
                looks_like_performance = bool(re.search(r"รอบ|วัน(?:ที่)?|เวลา|performance|show|date|time", f"{descriptor} {option_text}"))
                has_time_options = bool(re.search(r"\b\d{1,2}:\d{2}\b", option_text))
                if not looks_like_performance or (wanted_time and not has_time_options):
                    continue
                repeat_selector_seen = True
                matches = []
                for item in option_rows:
                    normalized = item["text"].casefold()
                    if wanted_time and wanted_time not in normalized:
                        continue
                    option_has_date = bool(re.search(r"\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2}|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม", normalized, re.I))
                    if option_has_date and date_tokens and not any(token.casefold() in normalized for token in date_tokens):
                        continue
                    matches.append(item)
                if len(matches) != 1:
                    record("performance_selection", {"status": "LOCKED_PERFORMANCE_MATCH_DEBUG", "descriptor": descriptor[:200], "wanted_time": wanted_time, "date_tokens": sorted(date_tokens), "options": [item["text"][:160] for item in option_rows], "match_count": len(matches)})
                    continue
                matched = matches[0]
                current_index = int(control.evaluate("element => element.selectedIndex"))
                if current_index == matched["index"]:
                    record("performance_selection", {"status": "LOCKED_PERFORMANCE_ALREADY_SELECTED", "label": matched["text"][:200], "schedule": CONFIG.get("schedule")})
                    return "matched"
                previous_url = safe_page_url(page)
                control.select_option(index=matched["index"])
                record("performance_selection", {"status": "LOCKED_PERFORMANCE_RESELECTED", "label": matched["text"][:200], "schedule": CONFIG.get("schedule"), "same_session": True})
                wait_for_page_change(page, previous_url, timeout_ms=3000)
                return "changed"
            except Exception:
                continue
    return "missing" if repeat_selector_seen else "absent"


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


def checkout_hidden_value(page, field_id):
    """Read a checkout state value without trusting visual active classes."""
    try:
        locator = page.locator(f"#{field_id}").first
        if locator.count():
            return str(locator.input_value(timeout=300) or "").strip()
    except Exception:
        pass
    return ""


def visible_checkout_validation(page):
    """Return a visible checkout validation message, if the site opened one."""
    validation_pattern = re.compile(
        r"กรุณาเลือกวิธีการรับบัตร|กรุณาเลือกวิธีการชำระเงิน|"
        r"ยอมรับข้อตกลง|please select the ticket delivery|"
        r"please select payment|please agree",
        re.I,
    )
    for scope in [page, *page.frames]:
        for selector in (".fancybox-wrap", "[role='dialog']", "#pnlMessage", "#popup-message"):
            dialogs = scope.locator(selector)
            try:
                count = min(dialogs.count(), 20)
            except Exception:
                continue
            for index in range(count):
                dialog = dialogs.nth(index)
                try:
                    if not dialog.is_visible(timeout=100):
                        continue
                    message = " ".join(dialog.inner_text(timeout=200).split())
                    if validation_pattern.search(message):
                        return message[:500]
                except Exception:
                    continue
    return ""


def dismiss_checkout_validation(page):
    """Dismiss only a known checkout validation modal so locked choices can retry."""
    message = visible_checkout_validation(page)
    if not message:
        return ""
    close_pattern = re.compile(r"^\s*(?:Close|ปิด|ตกลง|OK)\s*$", re.I)
    for scope in [page, *page.frames]:
        for role in ("button", "link"):
            locator = scope.get_by_role(role, name=close_pattern).first
            try:
                if locator.count() and locator.is_visible(timeout=200) and locator.is_enabled(timeout=200):
                    locator.click()
                    record("checkout_validation", {"status": "DISMISSED_FOR_LOCKED_RETRY", "message": message})
                    return message
            except Exception:
                continue
    return message


def select_verified_checkout_option(page, selector, state_field, wanted_labels, family_labels, field_name):
    """Select a checkout option and verify the site's hidden form state changed."""
    state_locator = page.locator(f"#{state_field}").first
    known_state_field = False
    try:
        known_state_field = bool(state_locator.count())
    except Exception:
        pass
    if selector:
        locator = page.locator(selector).first
        try:
            if locator.count() and locator.is_visible(timeout=300) and locator.is_enabled(timeout=300):
                locator.click()
                if known_state_field:
                    page.wait_for_function(
                        "fieldId => Boolean((document.getElementById(fieldId)?.value || '').trim())",
                        arg=state_field,
                        timeout=2000,
                    )
                record("action", {"action": "select_verified_option", "field": field_name, "selector": selector, "state_field": state_field})
                return "selected"
        except Exception as exc:
            record("checkout_validation", {"status": "OPTION_STATE_NOT_VERIFIED", "field": field_name, "selector": selector, "detail": str(exc)[:300]})
    result = semantic_select_if_present(page, wanted_labels, family_labels, field_name)
    if result == "selected" and known_state_field and not checkout_hidden_value(page, state_field):
        record("checkout_validation", {"status": "OPTION_STATE_EMPTY", "field": field_name, "state_field": state_field})
        return "failed"
    return result


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
    selected = CONFIG.get("selectedPerformance") if isinstance(CONFIG.get("selectedPerformance"), dict) else {}
    for key in ("label", "contextText"):
        value = str(selected.get(key, "")).strip()
        if value:
            labels.append(value)
    schedule = str(CONFIG.get("schedule", ""))
    labels.extend(re.findall(r"\b\d{1,2}:\d{2}\b", schedule))
    for control in CONFIG.get("saleEntryControls", CONFIG.get("purchaseControls", [])):
        label = str(control.get("label", "")).strip()
        if label:
            labels.append(label)
    labels.extend(["เลือกรอบ/ประเภทบัตร", "ซื้อบัตร", "จองบัตร", "buy now", "book now"])
    return list(dict.fromkeys(labels))


def fill_login(page):
    def session_already_authenticated():
        try:
            current = classify_snapshot(snapshot(page), sale_open_at=CONFIG.get("saleOpenAt", ""))
            if authenticated_account_marker(page) or authenticated_booking_session(page, current.get("state", "unknown")):
                record("authentication", {
                    "status": "SESSION_BECAME_AUTHENTICATED_DURING_INPUT",
                    "state": current.get("state", "unknown"),
                    "credentials_persisted": False,
                    "same_session": True,
                })
                return True
        except Exception:
            pass
        return False

    if session_already_authenticated():
        return True
    username = os.environ.get("TICKET_USERNAME", "").strip()
    password = os.environ.get("TICKET_PASSWORD", "")
    if not username:
        record("input_required", {"field": "username", "stage": "waiting_username", "prompt": "กรอกอีเมล/ชื่อผู้ใช้สำหรับเว็บขายบัตร", "secret": False})
        username = console_input("อีเมล/ชื่อผู้ใช้สำหรับเว็บขายบัตรนี้: ").strip()
        if session_already_authenticated():
            return True
    if not password:
        record("input_required", {"field": "password", "stage": "waiting_password", "prompt": "กรอกรหัสผ่านสำหรับเว็บขายบัตร", "secret": True})
        password = getpass.getpass("รหัสผ่าน (ไม่แสดงและไม่บันทึก): ") if sys.stdin.isatty() else console_input("รหัสผ่าน (รับผ่าน stdin และไม่บันทึก): ")
        if session_already_authenticated():
            return True
    # The member page renders its shell before attaching the real sign-in form.
    # Stay in automatic recovery while that transient render is incomplete.
    form_deadline = time.monotonic() + 30
    username_box = page.locator("input[name='username']:visible, input[type='email']:visible").first
    password_box = page.locator("input[name='password']:visible, input[type='password']:visible").first
    while time.monotonic() < form_deadline:
        if session_already_authenticated():
            return True
        try:
            if username_box.count() and password_box.count() and username_box.is_visible(timeout=250) and password_box.is_visible(timeout=250):
                break
        except Exception:
            pass
        page.wait_for_timeout(250)
    if not username or not password:
        if session_already_authenticated():
            return True
        return False
    if username_box.count() == 0 or password_box.count() == 0:
        record("recovery", {"status": "LOGIN_FORM_NOT_READY", "next_action": "rescan_same_page", "same_session": True})
        return None
    username_box.fill(username)
    password_box.fill(password)
    if not semantic_click(page, ["เข้าสู่ระบบ", "login", "sign in"]):
        return False
    record("action", {"action": "login_submit", "credentials_persisted": False, "same_session": True})
    return True


def wait_for_post_login_transition(page, previous_url, timeout_ms=12000):
    """Wait for the login XHR/redirect chain to settle before classifying the page.

    ThaiTicketMajor can briefly return 403 from its sign-in XHR and then complete a
    successful top-level redirect. Classifying during that short interval produced
    a false CAPTCHA handoff even though the authenticated terms page was loading.
    """
    deadline = time.monotonic() + max(1, timeout_ms) / 1000
    while time.monotonic() < deadline:
        try:
            password = page.locator("input[type='password']").first
            password_visible = bool(password.count() and password.is_visible(timeout=150))
        except Exception:
            password_visible = False
        if page.url != previous_url or not password_visible:
            try:
                page.wait_for_load_state("domcontentloaded", timeout=3000)
            except Exception:
                pass
            page.wait_for_timeout(500)
            return True
        page.wait_for_timeout(250)
    return False


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


def authenticated_booking_session(page, state):
    """Treat access to private booking steps as proof of an existing login session.

    A persisted ThaiTicketMajor session can skip the sign-in page entirely and its
    booking pages do not always render an account/logout marker. Reaching one of
    these stateful steps without a visible password field is stronger evidence than
    requiring the current run to have submitted the login form itself.
    """
    if state not in {"terms_conditions", "zone_selection", "quantity_selection", "ticket_selection", "attendee_details", "checkout_options", "payment_handoff"}:
        return False
    parsed = urlsplit(page.url)
    if parsed.hostname != "booking.thaiticketmajor.com":
        return False
    if not re.search(r"/(?:verify_condition|zones|fixed|festival|enroll|paymentall|payment[^/]*)\.php$", parsed.path, re.I):
        return False
    try:
        passwords = page.locator("input[type='password']")
        for index in range(passwords.count()):
            if passwords.nth(index).is_visible(timeout=150):
                return False
    except Exception:
        return False
    return True


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


def normalize_zone_availability(value):
    """Extract zone/count pairs from the official page response without replaying it."""
    result = {}
    if isinstance(value, dict):
        zone = str(value.get("zone") or value.get("zone_name") or value.get("section") or value.get("name") or "").strip().upper()
        count_value = value.get("available_count", value.get("available", value.get("qty", value.get("count"))))
        if zone and len(zone) <= 30 and isinstance(count_value, (int, float, str)):
            digits = re.sub(r"[^0-9]", "", str(count_value))
            if digits:
                result[zone] = int(digits)
        for child in value.values():
            result.update(normalize_zone_availability(child))
    elif isinstance(value, list):
        for child in value:
            result.update(normalize_zone_availability(child))
    return result


def parse_zone_availability_modal(page):
    zones = {}
    for scope in [page, *[frame for frame in page.frames if frame != page.main_frame]]:
        for selector in ("[role='dialog'] tr", ".modal:visible tr", ".modal-dialog tr", "table tr"):
            try:
                rows = scope.locator(selector)
                for index in range(min(rows.count(), 200)):
                    row = rows.nth(index)
                    if not row.is_visible(timeout=100):
                        continue
                    cells = [re.sub(r"\s+", " ", item).strip() for item in row.locator("th, td").all_text_contents()]
                    if len(cells) < 2:
                        continue
                    zone = cells[0].strip().upper()
                    count_text = re.sub(r"[^0-9]", "", cells[-1])
                    if re.fullmatch(r"[A-Z][A-Z0-9._/-]{0,29}", zone) and count_text:
                        zones[zone] = int(count_text)
            except Exception:
                continue
    return zones


def collect_zone_availability(page, force=False):
    settings = CONFIG.get("seatAvailability") if isinstance(CONFIG.get("seatAvailability"), dict) else {}
    if settings.get("enabled", CONFIG.get("seatMode") == "reserved") is False or CONFIG.get("seatMode") != "reserved":
        return {}
    cached = CONFIG.get("_runtimeZoneAvailability") if isinstance(CONFIG.get("_runtimeZoneAvailability"), dict) else {}
    if cached and not force:
        return dict(cached)
    button = None
    pattern = re.compile(r"ที่นั่งว่าง|จำนวนที่นั่งว่าง|available\s+seats?|seat\s+availability", re.I)
    for scope in [page, *[frame for frame in page.frames if frame != page.main_frame]]:
        for role in ("button", "link"):
            try:
                candidate = scope.get_by_role(role, name=pattern).first
                if candidate.count() and candidate.is_visible(timeout=150) and candidate.is_enabled(timeout=150):
                    button = candidate
                    break
            except Exception:
                continue
        if button is not None:
            break
    if button is None:
        record("seat_availability", {"source": "official_page_session", "available": False, "reason": "CONTROL_NOT_PRESENT", "standing_flow": False})
        return dict(cached)
    try:
        button.click(no_wait_after=True)
    except Exception as error:
        record("seat_availability", {"source": "official_page_session", "available": False, "reason": "CONTROL_CLICK_FAILED", "error": str(error)[:300]})
        return dict(cached)
    deadline = time.monotonic() + 3
    zones = {}
    while time.monotonic() < deadline and not zones:
        zones = parse_zone_availability_modal(page)
        if not zones:
            time.sleep(0.05)
    response_zones = LATEST_ZONE_AVAILABILITY_RESPONSE.get("zones") if isinstance(LATEST_ZONE_AVAILABILITY_RESPONSE.get("zones"), dict) else {}
    zones = {**response_zones, **zones}
    generation = int(CONFIG.get("_runtimeInventoryGeneration", 0) or 0) + 1
    CONFIG["_runtimeInventoryGeneration"] = generation
    CONFIG["_runtimeZoneAvailability"] = zones
    record("seat_availability", {
        "source": "official_page_session",
        "available": bool(zones),
        "zones": zones,
        "checked_at": datetime.now().astimezone().isoformat(),
        "inventory_generation": generation,
    })
    record("inventory_generation", {"generation": generation, "source": "seat_availability_modal", "zones": zones})
    try:
        close = page.locator("[role='dialog'] button, .modal-dialog button, .modal button").filter(has_text=re.compile(r"ปิด|close|×", re.I)).first
        if close.count() and close.is_visible(timeout=150):
            close.click(no_wait_after=True)
        else:
            page.keyboard.press("Escape")
    except Exception:
        pass
    return zones


def select_preferred_zone(page):
    recovery = CONFIG.get("seatRecovery") if isinstance(CONFIG.get("seatRecovery"), dict) else {}
    zones = expand_zone_preferences(CONFIG.get("_runtimeAvailableZones") or recovery.get("zoneOrder") or CONFIG.get("preferredZones", []))
    # The booking page can classify as zone_selection before its image-map is
    # attached. Scanning immediately produced USER_ZONE_REQUIRED even though
    # the official zone controls appeared a fraction of a second later.
    try:
        page.locator("area[href*='#'], [data-zone], [data-section]").first.wait_for(state="attached", timeout=5000)
    except Exception:
        pass
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
    auto_discovered_zones = bool(CONFIG.get("_runtimeAutoDiscoveredZones")) or (not zones and bool(discovered_names))
    if not zones:
        print("โซนที่พบจากหน้าจริง: " + (", ".join(discovered_names) if discovered_names else "ยังอ่านชื่อโซนไม่ได้"), flush=True)
        if discovered_names:
            # Keep the complete page order as the fallback, but do not select a
            # zone until the official availability modal has answered. A page
            # order is not an availability signal (the first map item is often
            # a sold-out standing/side zone).
            zones = list(discovered_names)
            CONFIG["_runtimeAutoDiscoveredZones"] = True
            CONFIG["preferredZones"] = list(zones)
            recovery["zoneOrder"] = list(zones)
            CONFIG["seatRecovery"] = recovery
            record("selection", {"mode": "zone", "strategy": "auto_page_order_with_fallbacks", "candidate_order": zones, "discovered": discovered_names, "complete": False, "reason": "DISCOVERED_PAGE_ORDER_WAITING_AVAILABILITY_FILTER"})
        else:
            record("selection", {"mode": "zone", "preferred": [], "discovered": discovered_names, "complete": False, "reason": "USER_ZONE_REQUIRED"})
            return False
    availability = collect_zone_availability(page, force=True)
    minimum = max(1, int(CONFIG.get("quantity", 1)))
    if not availability and auto_discovered_zones:
        # Empty means the modal/API was not ready or was transiently rejected;
        # it must not be interpreted as "the first zone is okay". Let the main
        # state machine retry in the same session and keep the user out of a
        # wrong seat map.
        CONFIG["_runtimeLastZoneSelectionReason"] = "AVAILABILITY_UNAVAILABLE"
        record("selection", {"mode": "zone", "preferred": zones, "discovered": discovered_names, "availability": {}, "complete": False, "reason": "AVAILABILITY_UNAVAILABLE_WAIT_AND_RESCAN", "wanted": minimum})
        return False
    ordered = [zone for zone in zones if zone not in availability or int(availability.get(zone, 0)) >= minimum]
    if auto_discovered_zones and availability:
        # With no user zone preference, choose the official zone with the
        # largest live inventory first. The previous page-order fallback chose
        # S=33 ahead of B=183 and caused avoidable seat conflicts.
        page_order = {zone: index for index, zone in enumerate(zones)}
        ordered.sort(key=lambda zone: (-int(availability.get(zone, 0)), page_order.get(zone, len(page_order))))
        record("selection", {"mode": "zone", "strategy": "official_availability_descending", "candidate_order": ordered, "availability": availability, "wanted": minimum})
    CONFIG["_runtimeAllowedZones"] = list(zones)
    CONFIG["_runtimeAvailableZones"] = list(ordered)
    if availability and not ordered:
        record("selection", {"mode": "zone", "preferred": zones, "availability": availability, "complete": False, "reason": "NO_ZONE_HAS_COMPLETE_SET", "wanted": minimum})
        return False
    for zone in ordered:
        for discovered_zone, locator in discovered:
            if discovered_zone != zone:
                continue
            locator.evaluate("element => element.click()")
            CONFIG["_runtimeCurrentZone"] = zone
            record("action", {"action": "select_image_map_zone", "zone": zone, "selector": f"area[href$='#{zone}']"})
            wait_for_seat_controls(page)
            return True
        locator = page.get_by_text(zone, exact=True).first
        try:
            if locator.count() and locator.is_visible(timeout=500) and locator.is_enabled():
                locator.click()
                CONFIG["_runtimeCurrentZone"] = zone
                record("action", {"action": "select_zone", "zone": zone})
                wait_for_seat_controls(page)
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
        try:
            if not locator.is_visible(timeout=200) or not locator.is_enabled(timeout=200):
                continue
        except Exception:
            continue
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


def visible_attendee_validation(page):
    """Return only validation messages that belong to the attendee form."""
    pattern = re.compile(
        r"กรุณากรอกชื่อ|กรุณาระบุชื่อ|กรุณากรอกนามสกุล|"
        r"please enter (?:full name|first name|last name)|"
        r"please enter name|name not duplicate",
        re.I,
    )
    for scope in [page, *page.frames]:
        for selector in (".fancybox-wrap", "[role='dialog']", "#pnlMessage", "#popup-message", ".modal"):
            dialogs = scope.locator(selector)
            try:
                count = min(dialogs.count(), 20)
            except Exception:
                continue
            for index in range(count):
                dialog = dialogs.nth(index)
                try:
                    if not dialog.is_visible(timeout=100):
                        continue
                    message = " ".join(dialog.inner_text(timeout=200).split())
                    if pattern.search(message):
                        return message[:500]
                except Exception:
                    continue
    return ""


def dismiss_attendee_validation(page):
    """Close a known attendee validation modal before an event-faithful retry."""
    message = visible_attendee_validation(page)
    if not message:
        return ""
    for selector in ("#btn_alert_ok", "#btn_message_ok", "[data-dismiss='modal']"):
        locator = page.locator(selector).first
        try:
            if locator.count() and locator.is_visible(timeout=200) and locator.is_enabled(timeout=200):
                locator.click(force=True)
                record("attendee_validation", {"status": "DISMISSED_FOR_LOCKED_RETRY", "message": message})
                return message
        except Exception:
            continue
    close_pattern = re.compile(r"^\s*(?:Close|ปิด|ตกลง|OK)\s*$", re.I)
    for scope in [page, *page.frames]:
        for role in ("button", "link"):
            locator = scope.get_by_role(role, name=close_pattern).first
            try:
                if locator.count() and locator.is_visible(timeout=200) and locator.is_enabled(timeout=200):
                    locator.click()
                    record("attendee_validation", {"status": "DISMISSED_FOR_LOCKED_RETRY", "message": message})
                    return message
            except Exception:
                continue
    return message


def fill_event_sensitive_input(locator, value):
    """Type through keyboard events for fields whose site logic rejects DOM-only fill."""
    expected = str(value).strip()
    if not expected:
        return False
    try:
        locator.click(force=True)
        locator.press("ControlOrMeta+A")
        locator.press("Backspace")
        locator.press_sequentially(expected, delay=18)
        locator.press("Tab")
        locator.dispatch_event("change")
        actual = str(locator.input_value(timeout=500) or "").strip()
        return actual == expected
    except Exception:
        try:
            locator.fill(expected)
            locator.dispatch_event("input")
            locator.dispatch_event("change")
            locator.dispatch_event("blur")
            actual = str(locator.input_value(timeout=500) or "").strip()
            return actual == expected
        except Exception:
            return False


def fill_attendee_details(page):
    dismiss_attendee_validation(page)
    previous_url = safe_page_url(page)
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
            value = console_input(f"หน้าเว็บคอนนี้ต้องการข้อมูล '{prompt_label}': ").strip()
        if not value:
            return False
        if not fill_event_sensitive_input(locator, value):
            record("attendee_validation", {"status": "FIELD_VALUE_NOT_ACCEPTED", "field": descriptor[:200], "values_logged": False})
            return False
    if count == 0:
        record("action", {"action": "event_specific_attendee_fields_absent", "skipped": True})
        return semantic_click(page, ["บันทึก", "save", "ดำเนินการต่อ", "continue"])
    submit = page.locator("#btn_regnow").first
    submitted = False
    try:
        if submit.count() and submit.is_visible(timeout=300) and submit.is_enabled(timeout=300):
            submit.click()
            submitted = True
    except Exception:
        submitted = False
    if not submitted:
        submitted = semantic_click(page, ["บันทึก", "save", "ดำเนินการต่อ", "continue"])
    if not submitted:
        return False
    wait_for_page_change(page, previous_url, timeout_ms=3500)
    message = visible_attendee_validation(page)
    if message:
        record("attendee_validation", {"status": "SUBMIT_REJECTED", "message": message, "values_logged": False})
        dismiss_attendee_validation(page)
        return False
    record("action", {"action": "fill_attendee_details", "count": count, "values_logged": False})
    return True


def select_checkout_options(page, confirm_order=False):
    # A failed submit leaves a modal over the form. Close only known validation
    # messages before retrying; otherwise the site can show a visual choice while
    # its hidden delivery/payment state is still empty.
    dismiss_checkout_validation(page)
    delivery = str(CONFIG.get("deliveryMethod", "pickup"))
    delivery_labels = ["รับบัตรด้วยตนเอง", "self pickup", "pick up"] if delivery == "pickup" else ["จัดส่งทางไปรษณีย์", "postal", "delivery"]
    delivery_result = select_verified_checkout_option(
        page,
        "#btn_pickup" if delivery == "pickup" else "#btn_thaipost",
        "deliver",
        delivery_labels,
        ["รับบัตรด้วยตนเอง", "self pickup", "pick up", "จัดส่งทางไปรษณีย์", "postal", "delivery"],
        "delivery_method",
    )
    if delivery_result == "failed":
        return False
    payment = str(CONFIG.get("paymentMethod", "qr"))
    payment_labels = ["QR", "PromptPay", "พร้อมเพย์"] if payment in {"qr", "promptpay"} else [payment]
    payment_result = select_verified_checkout_option(
        page,
        "#btn_kbankqr" if payment in {"qr", "promptpay"} else "",
        "paytype",
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
    if page.locator("#deliver").count() and not checkout_hidden_value(page, "deliver"):
        record("checkout_validation", {"status": "DELIVERY_STATE_EMPTY_BEFORE_CONFIRM"})
        return False
    if page.locator("#paytype").count() and not checkout_hidden_value(page, "paytype"):
        record("checkout_validation", {"status": "PAYMENT_STATE_EMPTY_BEFORE_CONFIRM"})
        return False
    previous_url = safe_page_url(page)
    clicked = semantic_click(page, ["ยืนยันการสั่งซื้อ", "confirm order"])
    if clicked:
        record("action", {"action": "confirm_unpaid_order", "payment_submitted": False})
        try:
            page.wait_for_function(
                "previous => location.href !== previous || [...document.querySelectorAll('.fancybox-wrap,[role=dialog],#pnlMessage,#popup-message')].some(el => (el.offsetWidth || el.offsetHeight) && /กรุณาเลือกวิธีการรับบัตร|กรุณาเลือกวิธีการชำระเงิน|ยอมรับข้อตกลง|please select|please agree/i.test(el.innerText || el.textContent || ''))",
                arg=previous_url,
                timeout=5000,
            )
        except Exception:
            pass
        validation = visible_checkout_validation(page)
        if validation:
            record("checkout_validation", {"status": "CONFIRM_REJECTED", "message": validation, "delivery": checkout_hidden_value(page, "deliver"), "paytype": checkout_hidden_value(page, "paytype")})
            dismiss_checkout_validation(page)
            return False
    return clicked


def current_zone_from_page(page):
    parsed = urlsplit(page.url)
    values = dict(parse_qsl(parsed.query, keep_blank_values=True))
    return str(values.get("zone") or values.get("section") or CONFIG.get("_runtimeCurrentZone") or "").strip().upper()


def seat_is_selected(locator):
    try:
        class_tokens = set((locator.get_attribute("class") or "").casefold().split())
        return bool(
            class_tokens.intersection({"seatcheck", "seat-selected", "selected-seat", "selected", "active"})
            or (locator.get_attribute("aria-pressed") or "").casefold() == "true"
            or (locator.get_attribute("data-selected") or "").casefold() == "true"
            or (locator.get_attribute("data-status") or "").casefold() == "selected"
            or (locator.evaluate("element => Boolean(element.checked)") if locator.evaluate("element => 'checked' in element") else False)
        )
    except Exception:
        return False


def selected_seat_count(page):
    total = 0
    for scope in [page, *[frame for frame in page.frames if frame != page.main_frame]]:
        try:
            total += int(scope.locator(SELECTED_SEAT_SELECTOR).count())
        except Exception:
            continue
    return total


def seat_conflict_key(seat):
    return "|".join(str(seat.get(key) or "").strip().upper() for key in ("zone", "row", "number", "label"))


def purge_conflict_blacklist():
    now_value = time.monotonic()
    expired = [key for key, expires_at in SEAT_CONFLICT_BLACKLIST.items() if float(expires_at or 0) <= now_value]
    for key in expired:
        SEAT_CONFLICT_BLACKLIST.pop(key, None)
    generation = int(CONFIG.get("_runtimeInventoryGeneration", 0) or 0)
    stale_generation_keys = [key for key, attempted_generation in SEAT_CONFLICT_GENERATION.items() if int(attempted_generation or 0) != generation]
    for key in stale_generation_keys:
        SEAT_CONFLICT_GENERATION.pop(key, None)


def blacklist_conflicted_seats(seats):
    recovery = CONFIG.get("seatRecovery") if isinstance(CONFIG.get("seatRecovery"), dict) else {}
    ttl_ms = max(250, int(recovery.get("conflictBlacklistTtlMs", 5000) or 5000))
    expires_at = time.monotonic() + ttl_ms / 1000
    generation = int(CONFIG.get("_runtimeInventoryGeneration", 0) or 0)
    labels = []
    for seat in seats:
        key = seat_conflict_key(seat)
        if key.strip("|"):
            SEAT_CONFLICT_BLACKLIST[key] = expires_at
            SEAT_CONFLICT_GENERATION[key] = generation
            labels.append(str(seat.get("label") or seat.get("number") or key)[:120])
    purge_conflict_blacklist()
    if labels:
        record("seat_blacklisted", {"seats": labels, "ttl_ms": ttl_ms, "inventory_generation": generation, "blacklist_size": len(SEAT_CONFLICT_GENERATION)})


def collect_seat_inventory(page, fallback_zone=""):
    purge_conflict_blacklist()
    metadata = []
    locators = []
    scopes = [page, *[frame for frame in page.frames if frame != page.main_frame]]
    blocked_tokens = {"seatsold", "sold", "occupied", "reserved", "unavailable", "disabled", "x"}
    for scope_index, scope in enumerate(scopes):
        seats = scope.locator(SEAT_SELECTOR)
        try:
            remaining = max(0, 1000 - len(locators))
            raw_items = seats.evaluate_all("""(elements, limit) => elements.slice(0, limit).map(element => {
              const style = getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              const className = typeof element.className === 'string' ? element.className : (element.getAttribute('class') || '');
              const classes = className.toLowerCase().split(/\\s+/).filter(Boolean);
              const selected = classes.some(name => ['seatcheck','seat-selected','selected-seat','selected','active'].includes(name))
                || (element.getAttribute('aria-pressed') || '').toLowerCase() === 'true'
                || (element.getAttribute('data-selected') || '').toLowerCase() === 'true'
                || (element.getAttribute('data-status') || '').toLowerCase() === 'selected'
                || Boolean(element.checked);
              return {
                raw_seat: element.getAttribute('data-seat') || element.getAttribute('data-seat-number') || element.getAttribute('data-seatk') || element.getAttribute('aria-label') || element.getAttribute('title') || element.id || '',
                zone: element.getAttribute('data-zone') || element.getAttribute('data-section') || '',
                row: element.getAttribute('data-row') || '',
                number: element.getAttribute('data-seat-number') || '',
                class_name: className,
                selected,
                visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
                enabled: !element.disabled && (element.getAttribute('aria-disabled') || '').toLowerCase() !== 'true'
              };
            })""", remaining)
        except Exception:
            continue
        for control_index, raw in enumerate(raw_items):
            locators.append(seats.nth(control_index))
            try:
                raw_seat = str(raw.get("raw_seat") or "")
                parsed = re.search(r"(?:^|\b)([A-Za-z]+)[-_ ]?(\d+)(?:\b|$)", raw_seat)
                class_tokens = set(str(raw.get("class_name") or "").casefold().split())
                selected = bool(raw.get("selected"))
                zone = str(raw.get("zone") or fallback_zone).strip().upper()
                row = str(raw.get("row") or (parsed.group(1) if parsed else "")).strip().upper()
                number = str(raw.get("number") or (parsed.group(2) if parsed else raw_seat)).strip()
                available = bool(raw.get("visible") and raw.get("enabled") and not selected and class_tokens.isdisjoint(blocked_tokens))
                item = {"zone": zone, "row": row, "number": number, "label": "-".join(value for value in (zone, row, number) if value)[:120], "available": available, "selected": selected, "visible": bool(raw.get("visible")), "scope_index": scope_index, "control_index": control_index}
                conflict_key = seat_conflict_key(item)
                current_generation = int(CONFIG.get("_runtimeInventoryGeneration", 0) or 0)
                if conflict_key in SEAT_CONFLICT_BLACKLIST or SEAT_CONFLICT_GENERATION.get(conflict_key) == current_generation:
                    item["available"] = False
                    item["blacklisted"] = True
                metadata.append(item)
            except Exception:
                metadata.append({"available": False, "scope_index": scope_index, "control_index": control_index})
    return metadata, locators, scopes


def reservation_token_fingerprint(page):
    parsed = urlsplit(page.url)
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    token = str(query.get("k") or query.get("reservation") or query.get("order") or "")
    return hashlib.sha256(token.encode("utf-8")).hexdigest()[:12] if token else ""


def accepted_reservation_responses_since(started_at):
    accepted = []
    for response in RESERVATION_RESPONSE_HISTORY:
        if float(response.get("at") or 0) < float(started_at or 0):
            continue
        try:
            payload = json.loads(str(response.get("body") or "{}"))
        except Exception:
            continue
        try:
            http_ok = 200 <= int(response.get("status") or 0) < 300
            status_ok = int(payload.get("status")) == 0
        except (TypeError, ValueError):
            http_ok = False
            status_ok = False
        if http_ok and payload.get("result") is True and status_ok and not str(payload.get("message") or "").strip():
            accepted.append(response)
    return accepted


def wait_for_selected_count(page, wanted, timeout_ms, attempt_started_at=0):
    if selected_seat_count(page) >= wanted:
        return True
    deadline = time.monotonic() + max(1, timeout_ms) / 1000
    for scope in [page, *[frame for frame in page.frames if frame != page.main_frame]]:
        remaining = max(1, int((deadline - time.monotonic()) * 1000))
        if remaining <= 1:
            break
        try:
            scope.wait_for_function(
                "args => document.querySelectorAll(args.selector).length >= args.wanted",
                arg={"selector": SELECTED_SEAT_SELECTOR, "wanted": wanted},
                timeout=remaining,
            )
            if selected_seat_count(page) >= wanted:
                return True
        except Exception:
            continue
    if selected_seat_count(page) >= wanted:
        return True
    # ThaiTicketMajor's fixed-seat page can keep the selected state outside the
    # DOM selectors while validateseat.php confirms each hold with
    # {result:true,status:0,message:""}. Count only fresh responses from this
    # exact click batch, never a stale response from a previous seat.
    return len(accepted_reservation_responses_since(attempt_started_at)) >= wanted


def release_partial_selection(page, timeout_ms=1500):
    before = selected_seat_count(page)
    if not before:
        return 0
    for scope in [page, *[frame for frame in page.frames if frame != page.main_frame]]:
        try:
            scope.locator(SELECTED_SEAT_SELECTOR).evaluate_all("elements => elements.forEach(element => element.click())")
        except Exception:
            continue
    try:
        page.wait_for_function("selector => document.querySelectorAll(selector).length === 0", arg=SELECTED_SEAT_SELECTOR, timeout=max(1, timeout_ms))
    except Exception:
        pass
    remaining = selected_seat_count(page)
    record("partial_released", {"released": max(0, before - remaining), "remaining": remaining, "complete": remaining == 0})
    return remaining


def switch_to_allowed_zone(page, zone):
    wanted = str(zone or "").strip().upper()
    if not wanted or current_zone_from_page(page) == wanted:
        return True
    for selector in (f"area[href$='#{wanted}']", f"[data-zone='{wanted}']", f"[data-section='{wanted}']"):
        try:
            locator = page.locator(selector).first
            if locator.count() and locator.is_enabled(timeout=200):
                previous_url = page.url
                locator.evaluate("element => element.click()")
                CONFIG["_runtimeCurrentZone"] = wanted
                wait_for_page_change(page, previous_url, timeout_ms=3000)
                wait_for_seat_controls(page, timeout_ms=3000)
                return True
        except Exception:
            continue
    try:
        locator = page.get_by_text(wanted, exact=True).first
        if locator.count() and locator.is_visible(timeout=200) and locator.is_enabled(timeout=200):
            previous_url = page.url
            locator.click(no_wait_after=True)
            CONFIG["_runtimeCurrentZone"] = wanted
            wait_for_page_change(page, previous_url, timeout_ms=3000)
            wait_for_seat_controls(page, timeout_ms=3000)
            return True
    except Exception:
        pass
    # Never forge a new zone query on a private booking URL. Its reservation
    # token is coupled to the server-side zone transition and rewriting only the
    # URL can produce error.php?errcode=9. Return through the site's own control
    # and select the requested fallback zone from the original map instead.
    previous_url = safe_page_url(page)
    if semantic_click(page, ["เลือกโซนอื่น", "เลือกโซน", "choose another zone", "back to zones"]):
        wait_for_page_change(page, previous_url, timeout_ms=5000)
        for selector in (f"area[href$='#{wanted}']", f"[data-zone='{wanted}']", f"[data-section='{wanted}']"):
            try:
                locator = page.locator(selector).first
                if locator.count() and locator.is_enabled(timeout=200):
                    zone_map_url = safe_page_url(page)
                    locator.evaluate("element => element.click()")
                    CONFIG["_runtimeCurrentZone"] = wanted
                    wait_for_page_change(page, zone_map_url, timeout_ms=3000)
                    wait_for_seat_controls(page, timeout_ms=3000)
                    return True
            except Exception:
                continue
    return False


def click_candidate_set(locators, metadata, indices):
    """Click a complete candidate set back-to-back with no model call or fixed sleep."""
    errors = []
    for index in indices:
        try:
            locators[index].evaluate("element => element.click()")
        except Exception as error:
            errors.append(str(error)[:180])
    return errors


def visible_human_challenge(page):
    """Return True only for a visible CAPTCHA/challenge, not an invisible token iframe."""
    if not page_is_alive(page):
        return False
    try:
        visible_marker = page.locator("body").evaluate(
            """body => {
              const pattern = /captcha|recaptcha|hcaptcha|verify[ ]+you[ ]+are[ ]+human|security[ ]+check/i;
              const visible = element => {
                const style = getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return style.display !== 'none' && style.visibility !== 'hidden' &&
                  Number(style.opacity || 1) > 0.1 && rect.width >= 40 && rect.height >= 20 &&
                  rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
              };
              const markers = body.querySelectorAll("iframe, [class*='captcha' i], [id*='captcha' i], [data-sitekey], [aria-label*='captcha' i], [title*='captcha' i]");
              for (const element of markers) {
                const marker = [element.id, element.className, element.getAttribute('title'), element.getAttribute('aria-label'), element.getAttribute('src')].join(' ');
                if (pattern.test(marker) && visible(element)) return true;
              }
              for (const element of body.querySelectorAll('*')) {
                if (!visible(element)) continue;
                const directText = [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent || '').join(' ').trim();
                if (directText && pattern.test(directText)) return true;
              }
              return false;
            }"""
        )
        if visible_marker:
            return True
    except Exception:
        pass
    challenge_pattern = re.compile(r"captcha|recaptcha|hcaptcha|verify\s+you\s+are\s+human|security\s+check", re.I)
    for scope in [frame for frame in page.frames if frame != page.main_frame]:
        try:
            owner = scope.frame_element()
            presentation = owner.evaluate(
                """element => {
                  const style = getComputedStyle(element);
                  const rect = element.getBoundingClientRect();
                  return {
                    displayed: style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0.1,
                    inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
                    width: rect.width,
                    height: rect.height,
                  };
                }"""
            )
            if presentation.get("displayed") and presentation.get("inViewport") and presentation.get("width", 0) >= 100 and presentation.get("height", 0) >= 40:
                marker = " ".join([str(scope.url), str(owner.get_attribute("title") or ""), str(owner.get_attribute("name") or "")])
                if challenge_pattern.search(marker):
                    return True
        except Exception:
            continue
    return False


def fast_reserved_seat_recovery(page):
    wanted = max(1, int(CONFIG.get("quantity", 1)))
    rows = [str(item).strip().upper() for item in CONFIG.get("preferredRows", []) if str(item).strip()]
    seat_numbers = [str(item).strip().upper() for item in CONFIG.get("preferredSeatNumbers", []) if str(item).strip()]
    grouping = str(CONFIG.get("seatGrouping", "adjacent"))
    fallback_mode = str(CONFIG.get("seatFallbackMode", "nearest"))
    recovery = CONFIG.get("seatRecovery") if isinstance(CONFIG.get("seatRecovery"), dict) else {}
    zones = expand_zone_preferences(CONFIG.get("_runtimeAvailableZones") or recovery.get("zoneOrder") or CONFIG.get("preferredZones", []))
    max_attempts = max(0, int(recovery.get("maxAttempts", 0) or 0))
    verify_timeout = max(250, int(recovery.get("clickVerificationTimeoutMs", 2500) or 2500))
    rescan_interval = max(100, int(recovery.get("inventoryRescanIntervalMs", 750) or 750))
    release_partial = recovery.get("releasePartialBeforeRetry", True) is not False
    attempt = 0
    zone_cursor = 0
    exhausted_rounds = 0
    unknown_layout_rounds = 0
    failure_fingerprints = {}
    ready_marker_key = None
    readiness_failures = 0
    current_zone = current_zone_from_page(page)
    if not zones and current_zone:
        zones = [current_zone]

    pending_acceptance = CONFIG.get("_runtimePendingServerSeatAcceptance")
    if isinstance(pending_acceptance, dict) and pending_acceptance.get("wanted") == wanted:
        record("seat_set_server_accepted", {
            **pending_acceptance,
            "status": "AWAITING_CHECKOUT_TRANSITION",
            "duplicate_click_prevented": True,
            "next_action": "continue_to_checkout",
        })
        return {
            "ok": True,
            "terminal": None,
            "attempts": int(pending_acceptance.get("attempt") or 0),
            "zone": pending_acceptance.get("zone", ""),
            "seats": pending_acceptance.get("seats", []),
            "selected": int(pending_acceptance.get("selected") or 0),
            "verification_pending": True,
        }

    while max_attempts == 0 or attempt < max_attempts:
        loop_marker = navigation_marker(page)
        checkpoint = classify_snapshot(snapshot(page), sale_open_at=CONFIG.get("saleOpenAt", ""))
        if checkpoint["state"] == "browser_lost":
            record("recovery", {"status": "BROWSER_LOST_DURING_SEAT_RECOVERY", "terminal": False, "next_action": "relaunch_same_profile_and_resume", "attempt": attempt})
            return {"ok": False, "terminal": "browser_lost", "attempts": attempt}
        if checkpoint["state"] != "ticket_selection":
            wait_for_manual_idle(page, "ticket_selection", checkpoint["state"])
            return {"ok": False, "terminal": "state_changed", "state": checkpoint["state"], "attempts": attempt}
        marker_key = (loop_marker.get("generation"), loop_marker.get("dom_generation"), loop_marker.get("url"))
        if ready_marker_key != marker_key:
            readiness = wait_for_stable_seat_inventory(
                page,
                current_zone_from_page(page),
                timeout_ms=max(3000, int(recovery.get("seatMapReadyTimeoutMs", 12000) or 12000)),
            )
            if not readiness.get("ready"):
                readiness_failures += 1
                readiness_state = str(readiness.get("state") or "ticket_selection")
                if readiness_state == "browser_lost":
                    record("recovery", {"status": "BROWSER_LOST_WHILE_LOADING_SEAT_MAP", "terminal": False, "attempt": attempt})
                    return {"ok": False, "terminal": "browser_lost", "attempts": attempt}
                if readiness_state != "ticket_selection":
                    wait_for_manual_idle(page, "ticket_selection", readiness_state)
                    return {"ok": False, "terminal": "state_changed", "state": readiness_state, "attempts": attempt}
                record("recovery", {
                    "status": "SEAT_MAP_NOT_READY_RESCAN",
                    "reason": readiness.get("reason", "unknown"),
                    "failure_count": readiness_failures,
                    "terminal": False,
                    "same_session": True,
                    "next_action": "wait_for_stable_inventory",
                })
                if readiness_failures >= 2:
                    schedule_ai_runtime_analysis(page, checkpoint, context={
                        "phase": "seat_map_loading",
                        "seat_incident": True,
                        "failure": "seat_map_did_not_reach_stable_inventory",
                        "same_failure_count": readiness_failures,
                        "candidate_count": 0,
                        "visual_required": False,
                    })
                wait_for_inventory_change(page, rescan_interval)
                continue
            readiness_failures = 0
            ready_marker = readiness.get("marker") or navigation_marker(page)
            ready_marker_key = (ready_marker.get("generation"), ready_marker.get("dom_generation"), ready_marker.get("url"))
            loop_marker = ready_marker
        ready_decision = collect_ai_runtime_analysis()
        if (
            ready_decision
            and ready_decision.get("state") == "ticket_selection"
            and not ready_decision.get("stale")
            and not ready_decision.get("unavailable")
            and ready_decision.get("action") in {"dismiss_runtime_dialog", "rescan_inventory", "release_partial", "switch_allowed_zone", "request_user"}
        ):
            ready_action = str(ready_decision.get("action") or "")
            execution_key = f"ticket_selection:{ready_decision.get('strategy_key', '')}:{ready_action}"
            if time.monotonic() - float(AI_ACTION_LAST_EXECUTED.get(execution_key, 0)) >= 5:
                AI_ACTION_LAST_EXECUTED[execution_key] = time.monotonic()
                if ready_action == "request_user":
                    record("handoff", {"status": "AI_REQUESTED_USER_RECOVERY", "same_session": True, "reason": ready_decision.get("reason", ""), "payment_submitted": False})
                    return {"ok": False, "terminal": "ai_handoff", "attempts": attempt, "ai_decision": ready_decision}
                executed = execute_validated_ai_action(page, checkpoint, ready_decision)
                record("supervisor_action", {
                    "status": "AI_ACTION_EXECUTED" if executed else "AI_ACTION_FAILED",
                    "state": "ticket_selection",
                    "action": ready_action,
                    "strategy_key": ready_decision.get("strategy_key", ""),
                    "model_controlled": True,
                    "live_visual_used": bool(ready_decision.get("screenshot_included")),
                    "payment_submitted": False,
                })
                if executed:
                    continue
        # Normal seat selection stays deterministic and fast. A fresh live
        # visual/DOM model call is reserved for an observed failure fingerprint
        # or blocking dialog, where continuing blind clicks would be slower.
        if checkpoint["state"] in {"sold_out", "sale_closed"}:
            return {"ok": False, "terminal": checkpoint["state"], "attempts": attempt}
        active_zone = zones[zone_cursor] if zones else current_zone_from_page(page)
        if active_zone and current_zone_from_page(page) not in {"", active_zone}:
            if not switch_to_allowed_zone(page, active_zone):
                record("zone_switch", {"status": "ZONE_CONTROL_NOT_AVAILABLE", "zone": active_zone, "attempt": attempt})
                zone_cursor = (zone_cursor + 1) % max(1, len(zones))
                continue
        current_zone = current_zone_from_page(page) or active_zone
        metadata, locators, scopes = collect_seat_inventory(page, current_zone)
        available_count = sum(1 for item in metadata if item.get("available"))
        record("seat_scan", {"zone": current_zone, "available": available_count, "candidate_count": len(metadata), "wanted": wanted, "attempt": attempt + 1, "scope_count": len(scopes)})
        zone_filter = [current_zone] if current_zone else zones
        indices = choose_seat_indices(metadata, wanted, grouping, zone_filter, rows, seat_numbers, fallback_mode)
        if len(indices) != wanted:
            unknown_layout_rounds = unknown_layout_rounds + 1 if not metadata else 0
            if not metadata and visible_human_challenge(page):
                evidence_path = capture_status_evidence(page, "CAPTCHA_AT_SEAT_MAP")
                record("handoff", {"status": "CAPTCHA_HANDOFF", "resume_supported": True, "same_session": True, "evidence_path": evidence_path})
                return {"ok": False, "terminal": "captcha_handoff", "attempts": attempt}
            if zones and zone_cursor + 1 < len(zones):
                previous_zone = current_zone
                zone_cursor += 1
                next_zone = zones[zone_cursor]
                switched = switch_to_allowed_zone(page, next_zone)
                record("zone_switch", {"status": "SWITCHED" if switched else "CONTROL_NOT_AVAILABLE", "from_zone": previous_zone, "to_zone": next_zone, "reason": "NO_COMPLETE_SET", "wanted": wanted})
                continue
            exhausted_rounds += 1
            zone_cursor = 0
            record("recovery", {"status": "WAITING_FOR_COMPLETE_SET", "zones": zones or [current_zone], "wanted": wanted, "round": exhausted_rounds, "next_action": "rescan_inventory", "terminal": False})
            if zones and semantic_click(page, ["เลือกโซนอื่น", "เลือกโซน", "choose another zone", "back to zones"]):
                wait_for_page_change(page, loop_marker.get("url", ""), timeout_ms=3000)
                changed = classify_snapshot(snapshot(page), sale_open_at=CONFIG.get("saleOpenAt", ""))
                if changed["state"] != "ticket_selection":
                    wait_for_manual_idle(page, "ticket_selection", changed["state"])
                    return {"ok": False, "terminal": "state_changed", "state": changed["state"], "attempts": attempt}
            if unknown_layout_rounds >= max(2, len(zones) or 1):
                visual_context = {
                    "phase": "unknown_seat_layout",
                    "failure": "no_machine_readable_seat_controls",
                    "round": exhausted_rounds,
                    "wanted": wanted,
                    "allowed_zones": zones,
                    "visual_required": True,
                }
                decision = request_ai_recovery_action(
                    page,
                    checkpoint,
                    ["rescan_inventory", "switch_allowed_zone", "request_user"],
                    context=visual_context,
                )
                if decision.get("action") == "request_user":
                    return {"ok": False, "terminal": "visual_handoff", "attempts": attempt, "ai_decision": decision}
                if decision.get("action") == "switch_allowed_zone" and zones:
                    current = current_zone_from_page(page)
                    candidates = zones[zones.index(current) + 1:] if current in zones else zones
                    if candidates and switch_to_allowed_zone(page, candidates[0]):
                        zone_cursor = zones.index(candidates[0])
                        unknown_layout_rounds = 0
                        continue
            wait_for_inventory_change(page, rescan_interval)
            continue

        attempt += 1
        planned = [str(metadata[index].get("label") or metadata[index].get("number") or index) for index in indices]
        record("seat_set_planned", {"zone": current_zone, "seats": planned, "wanted": wanted, "grouping": grouping, "attempt": attempt})
        before_click = navigation_marker(page)
        if before_click.get("generation") != loop_marker.get("generation") or before_click.get("url") != loop_marker.get("url"):
            changed = classify_snapshot(snapshot(page), sale_open_at=CONFIG.get("saleOpenAt", ""))
            record("navigation_interrupt", {"from_state": "ticket_selection", "to_state": changed["state"], "url": safe_page_url(page), "old_task_cancelled": True, "phase": "before_seat_click"})
            if changed["state"] != "ticket_selection":
                wait_for_manual_idle(page, "ticket_selection", changed["state"])
                return {"ok": False, "terminal": "state_changed", "state": changed["state"], "attempts": attempt}
            continue
        if release_partial and selected_seat_count(page):
            release_partial_selection(page, verify_timeout)
        attempt_started_at = time.monotonic()
        LATEST_RESERVATION_RESPONSE.update({"status": None, "url": "", "body": "", "at": attempt_started_at})
        errors = click_candidate_set(locators, metadata, indices)
        record("seat_attempt", {"zone": current_zone, "seats": planned, "wanted": wanted, "attempt": attempt, "click_errors": errors})
        complete = not errors and wait_for_selected_count(page, wanted, verify_timeout, attempt_started_at=attempt_started_at)
        selected = selected_seat_count(page)
        if complete:
            accepted_count = len(accepted_reservation_responses_since(attempt_started_at))
            if selected >= wanted:
                record("reservation_verified", {
                    "status": "SEAT_HOLD_VERIFIED",
                    "zone": current_zone,
                    "seats": planned,
                    "selected": selected,
                    "wanted": wanted,
                    "attempt": attempt,
                    "reservation_token_fingerprint": reservation_token_fingerprint(page),
                    "verification": "selected seat DOM reached the locked quantity",
                })
                return {"ok": True, "terminal": None, "attempts": attempt, "zone": current_zone, "seats": planned, "selected": selected, "verification_pending": False}
            pending = {
                "zone": current_zone,
                "seats": planned,
                "selected": selected,
                "wanted": wanted,
                "attempt": attempt,
                "accepted_response_count": accepted_count,
                "reservation_token_fingerprint": reservation_token_fingerprint(page),
                "verification": "fresh validateseat.php responses accepted the exact locked quantity; awaiting checkout transition",
            }
            CONFIG["_runtimePendingServerSeatAcceptance"] = pending
            record("seat_set_server_accepted", {
                **pending,
                "status": "SERVER_ACCEPTED_EXACT_SET",
                "duplicate_click_prevented": True,
                "next_action": "continue_to_checkout",
            })
            return {"ok": True, "terminal": None, "attempts": attempt, "zone": current_zone, "seats": planned, "selected": selected, "verification_pending": True}
        dialogs = visible_runtime_dialogs(page)
        response_summary = str(LATEST_RESERVATION_RESPONSE.get("body") or "")[:600]
        failure_source = "|".join([
            checkpoint.get("state", ""),
            urlsplit(safe_page_url(page)).path,
            current_zone,
            str(selected),
            str(LATEST_RESERVATION_RESPONSE.get("status") or ""),
            str((dialogs[0] if dialogs else {}).get("fingerprint") or "no-dialog"),
            response_summary,
        ])
        failure_fingerprint = hashlib.sha256(failure_source.encode("utf-8", errors="ignore")).hexdigest()[:20]
        failure_fingerprints[failure_fingerprint] = failure_fingerprints.get(failure_fingerprint, 0) + 1
        record("seat_conflict", {
            "status": "SET_REJECTED_OR_INCOMPLETE",
            "zone": current_zone,
            "seats": planned,
            "selected": selected,
            "wanted": wanted,
            "attempt": attempt,
            "http_status": LATEST_RESERVATION_RESPONSE.get("status"),
            "response_summary": response_summary,
            "visible_dialogs": dialogs,
            "failure_fingerprint": failure_fingerprint,
            "same_failure_count": failure_fingerprints[failure_fingerprint],
            "next_action": "release_partial_and_rescan_same_zone",
        })
        # A modal can block the whole seat map while element.click() keeps
        # dispatching events behind it. Escalate the *current live state* to
        # Alpha instead of burning through every seat with a stale advisor.
        if dialogs or failure_fingerprints[failure_fingerprint] >= 2:
            record("ai_supervisor_trigger", {
                "status": "LIVE_SEAT_FAILURE_ESCALATION",
                "state": "ticket_selection",
                "failure_fingerprint": failure_fingerprint,
                "same_failure_count": failure_fingerprints[failure_fingerprint],
                "dialog_count": len(dialogs),
                "live_visual_required": True,
            })
            # Never block the seat critical path on a 9B inference. Queue the
            # fresh live DOM/network analysis and consume its validated action
            # on the next scan while deterministic recovery keeps moving.
            schedule_ai_runtime_analysis(page, checkpoint, context={
                "phase": "seat_validation_failure",
                "seat_incident": True,
                "failure": "seat_click_did_not_create_a_verified_hold",
                "failure_fingerprint": failure_fingerprint,
                "same_failure_count": failure_fingerprints[failure_fingerprint],
                "planned_seats": planned,
                "visible_dialogs": dialogs,
                "reservation_response": response_summary,
                "visual_required": bool(dialogs),
            })
            record("supervisor_action", {
                "status": "AI_ANALYSIS_QUEUED_NON_BLOCKING",
                "state": "ticket_selection",
                "action": "analyze_live_seat_failure",
                "failure_fingerprint": failure_fingerprint,
                "model_controlled": True,
                "live_visual_used": bool(dialogs),
                "payment_submitted": False,
            })
            if dialogs and dismiss_runtime_dialog(page):
                continue
        blacklist_conflicted_seats([metadata[index] for index in indices])
        if release_partial:
            release_partial_selection(page, verify_timeout)
        wait_for_inventory_change(page, rescan_interval)
    return {"ok": False, "terminal": "attempt_limit", "attempts": attempt}


def apply_ticket_preferences(page):
    wanted = max(1, int(CONFIG.get("quantity", 1)))
    if CONFIG.get("seatMode") == "reserved":
        return fast_reserved_seat_recovery(page)
    label_pattern = re.compile(r"quantity|qty|จำนวน", re.I)
    locator = page.get_by_label(label_pattern).first
    try:
        if locator.is_visible(timeout=500) and locator.is_enabled():
            tag = locator.evaluate("element => element.tagName.toLowerCase()")
            if tag == "select":
                locator.select_option(str(wanted))
            else:
                locator.fill(str(wanted))
            record("reservation_verified", {"status": "QUANTITY_VERIFIED", "mode": CONFIG.get("seatMode"), "wanted": wanted, "selected": wanted})
            return {"ok": True, "terminal": None, "attempts": 1, "selected": wanted}
    except Exception:
        pass
    record("seat_conflict", {"status": "QUANTITY_CONTROL_NOT_AVAILABLE", "mode": CONFIG.get("seatMode"), "wanted": wanted, "selected": 0})
    return {"ok": False, "terminal": None, "attempts": 1}


def redact_ai_text(value):
    text = str(value or "")
    text = re.sub(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", "[EMAIL]", text, flags=re.I)
    text = re.sub(r"\b(?:\d[ -]*?){8,19}\b", "[NUMBER]", text)
    text = re.sub(r"(?i)(password|รหัสผ่าน|otp|token)\s*[:=]?\s*\S+", r"\1=[REDACTED]", text)
    text = re.sub(r"(?i)([?&](?:k|token|session|reservation|order)=)[^&\s]+", r"\1[REDACTED]", text)
    text = re.sub(r"\b[A-Fa-f0-9]{24,}\b", "[TOKEN]", text)
    return text


def safe_response_excerpt(value):
    """Keep only a short redacted network result for live failure diagnosis."""
    text = redact_ai_text(value)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:600]


RUNTIME_DIALOG_SELECTORS = (
    ".fancybox-wrap", "[role='dialog']", "#pnlMessage", "#popup-message",
    ".modal", ".modal-dialog", ".swal2-popup", ".sweet-alert", ".bootbox",
    ".ui-dialog", "#message", "#msgbox",
)


def visible_runtime_dialogs(page):
    """Return the current visible dialog state for the supervisor.

    This is a live DOM read from Alpha's own browser session. It does not rely
    on a user-provided screenshot and never returns credentials or raw tokens.
    """
    dialogs = []
    seen = set()
    for frame_index, scope in enumerate([page, *[frame for frame in page.frames if frame != page.main_frame]]):
        for selector in RUNTIME_DIALOG_SELECTORS:
            try:
                candidates = scope.locator(selector)
                count = min(candidates.count(), 20)
            except Exception:
                continue
            for index in range(count):
                dialog = candidates.nth(index)
                try:
                    if not dialog.is_visible(timeout=100):
                        continue
                    text = redact_ai_text(" ".join(dialog.inner_text(timeout=250).split()))[:900]
                    buttons = []
                    actions = dialog.locator(ACTIONABLE_SELECTOR)
                    for action_index in range(min(actions.count(), 20)):
                        action = actions.nth(action_index)
                        if not action.is_visible(timeout=80) or not action.is_enabled(timeout=80):
                            continue
                        label = redact_ai_text(" ".join(filter(None, [
                            action.inner_text(timeout=100),
                            action.get_attribute("aria-label") or "",
                            action.get_attribute("value") or "",
                            action.get_attribute("title") or "",
                        ])).strip())[:160]
                        if label:
                            buttons.append(label)
                    source = f"{urlsplit(str(getattr(scope, 'url', ''))).path}|{text}|{'|'.join(buttons)}"
                    fingerprint = hashlib.sha256(source.encode("utf-8", errors="ignore")).hexdigest()[:20]
                    if fingerprint in seen or not (text or buttons):
                        continue
                    seen.add(fingerprint)
                    dialogs.append({
                        "fingerprint": fingerprint,
                        "text": text,
                        "buttons": buttons,
                        "frame_index": frame_index,
                        "selector": selector,
                    })
                except Exception:
                    continue
    return dialogs[:8]


def dismiss_runtime_dialog(page):
    """Dismiss one non-sensitive runtime dialog using a validated close action."""
    dialogs = visible_runtime_dialogs(page)
    if not dialogs:
        return False
    combined = " ".join(item.get("text", "") for item in dialogs)
    if re.search(r"captcha|recaptcha|hcaptcha|otp|one[- ]time|รหัสยืนยัน|ชำระเงินจริง|payment|qr\s*code", combined, re.I):
        record("dialog_detected", {"status": "HUMAN_HANDOFF_DIALOG", "dialogs": dialogs, "dismissed": False})
        return False
    exact_close = re.compile(r"^\s*(?:OK|ตกลง|Close|ปิด|×)\s*$", re.I)
    for selector in ("#btn_alert_ok", "#btn_message_ok", "[data-dismiss='modal']", ".fancybox-close", ".swal2-confirm"):
        for scope in [page, *[frame for frame in page.frames if frame != page.main_frame]]:
            try:
                control = scope.locator(selector).first
                if control.count() and control.is_visible(timeout=150) and control.is_enabled(timeout=150):
                    control.click(force=True)
                    record("dialog_detected", {"status": "DISMISSED_BY_AI_RUNTIME", "dialogs": dialogs, "selector": selector, "dismissed": True})
                    return True
            except Exception:
                continue
    for scope in [page, *[frame for frame in page.frames if frame != page.main_frame]]:
        for role in ("button", "link"):
            try:
                control = scope.get_by_role(role, name=exact_close).first
                if control.count() and control.is_visible(timeout=150) and control.is_enabled(timeout=150):
                    control.click(force=True)
                    record("dialog_detected", {"status": "DISMISSED_BY_AI_RUNTIME", "dialogs": dialogs, "role": role, "dismissed": True})
                    return True
            except Exception:
                continue
    record("dialog_detected", {"status": "NO_VALIDATED_DISMISS_CONTROL", "dialogs": dialogs, "dismissed": False})
    return False


def capture_ai_visual_snapshot(page, status="ai-visual-analysis"):
    """Capture the current browser frame for Alpha's local vision model.

    The frame comes directly from Alpha's live Playwright page; the user never
    has to attach images. Login and credential states are excluded.
    """
    if not page_is_alive(page):
        return {"image_base64": "", "evidence_path": ""}
    evidence_dir = Path(os.environ.get("ALPHA_TICKET_EVIDENCE_DIR") or (ROOT / "evidence"))
    evidence_dir.mkdir(parents=True, exist_ok=True)
    destination = evidence_dir / f"{datetime.now().astimezone().strftime('%Y%m%d-%H%M%S')}-{status}.jpg"
    try:
        image_bytes = page.screenshot(path=str(destination), type="jpeg", quality=70, full_page=False)
        return {"image_base64": base64.b64encode(image_bytes).decode("ascii"), "evidence_path": str(destination)}
    except Exception as error:
        record("evidence_error", {"status": status, "error": str(error)[:500], "url": safe_page_url(page)})
        return {"image_base64": "", "evidence_path": ""}


def sanitized_recovery_snapshot(page, checkpoint, include_visual=False):
    page_snapshot = snapshot(page)
    body = redact_ai_text(page_snapshot.get("body", ""))[:1600]
    controls = []
    for index, item in enumerate(page_snapshot.get("actionable_controls", [])[:32]):
        controls.append({
            "control_id": f"control-{index}",
            "label": redact_ai_text(item.get("label", ""))[:200],
            "tag": str(item.get("tag", ""))[:30],
        })
    result = {
        "state": checkpoint.get("state"),
        "url": urlunsplit((*urlsplit(safe_page_url(page))[:3], "", "")),
        "body": body,
        "controls": controls,
        "visible_dialogs": page_snapshot.get("visible_dialogs", []),
        "seat_control_count": page_snapshot.get("seat_control_count", 0),
        "selected_count": selected_seat_count(page),
        "wanted_count": max(1, int(CONFIG.get("quantity", 1))),
        "current_zone": current_zone_from_page(page),
        "allowed_zones": expand_zone_preferences(CONFIG.get("_runtimeAvailableZones") or (CONFIG.get("seatRecovery") or {}).get("zoneOrder") or CONFIG.get("preferredZones", [])),
        "locked_event": str(CONFIG.get("eventName", ""))[:200],
        "locked_schedule": str(CONFIG.get("schedule", ""))[:120],
        "last_reservation_response": {
            "status": LATEST_RESERVATION_RESPONSE.get("status"),
            "url": urlunsplit((*urlsplit(str(LATEST_RESERVATION_RESPONSE.get("url") or ""))[:3], "", "")),
            "body": redact_ai_text(LATEST_RESERVATION_RESPONSE.get("body", ""))[:600],
        },
    }
    if include_visual and checkpoint.get("state") not in {"login", "captcha_handoff", "otp_handoff", "payment_handoff"}:
        visual = capture_ai_visual_snapshot(page)
        if visual.get("image_base64"):
            result["_image_base64"] = visual["image_base64"]
            result["_image_evidence_path"] = visual.get("evidence_path", "")
    return result


def ai_actions_for_state(state):
    actions = {
        "pre_sale": ["wait", "rescan"],
        "armed_pre_sale": ["wait", "rescan"],
        "waiting_room_entry": ["activate_verified_control", "rescan", "wait", "reload_same_url", "request_user"],
        "queue": ["wait"],
        "server_unavailable": ["wait", "reload_same_url"],
        "sale_entry": ["activate_locked_performance", "rescan", "wait", "reload_same_url", "request_user"],
        "access_denied": ["wait", "reload_same_url"],
        "reservation_expired": ["return_seat_map", "rescan"],
        "login": ["fill_login", "rescan", "request_user"],
        "captcha_handoff": ["request_user"],
        "otp_handoff": ["request_user"],
        "terms_conditions": ["accept_terms", "rescan", "wait", "request_user"],
        "zone_selection": ["activate_locked_performance", "select_allowed_zone", "rescan", "wait", "request_user"],
        "quantity_selection": ["apply_locked_quantity", "rescan", "wait", "request_user"],
        "ticket_selection": ["fast_seat_engine", "dismiss_runtime_dialog", "rescan_inventory", "release_partial", "switch_allowed_zone", "rescan", "wait", "request_user"],
        "attendee_details": ["fill_locked_attendees", "rescan", "wait", "request_user"],
        "checkout_options": ["apply_locked_checkout", "rescan", "wait", "request_user"],
        "payment_handoff": ["notify_user"],
        "browser_lost": ["request_user"],
        "sold_out": ["stop"],
        "sale_closed": ["stop"],
        "unknown": ["rescan", "reload_same_url", "wait", "request_user"],
    }
    return actions.get(str(state), ["rescan", "wait", "request_user"])


def ai_strategy_key(snapshot_data):
    source = "|".join([
        str(snapshot_data.get("state", "")),
        str(urlsplit(str(snapshot_data.get("url", ""))).path),
        str(snapshot_data.get("current_zone", "")),
        " ".join(item.get("label", "") for item in snapshot_data.get("controls", [])[:12]),
        " ".join(item.get("fingerprint", "") for item in snapshot_data.get("visible_dialogs", [])[:4]),
        str((snapshot_data.get("last_reservation_response") or {}).get("body", "")),
    ])
    return hashlib.sha256(source.encode("utf-8", errors="ignore")).hexdigest()[:20]


def load_ai_strategies():
    try:
        payload = json.loads(AI_STRATEGY_PATH.read_text(encoding="utf-8"))
        return payload if isinstance(payload, list) else []
    except Exception:
        return []


def matching_ai_strategies(strategy_key, state):
    return [
        item for item in load_ai_strategies()
        if item.get("strategy_key") == strategy_key or item.get("state") == state
    ][-5:]


def remember_ai_strategy(decision, from_state, to_state):
    if not (CONFIG.get("aiRuntime") or {}).get("strategyMemory", True) or not decision:
        return
    action = str(decision.get("action", ""))
    if action in {"", "wait", "rescan", "request_user", "notify_user", "stop"}:
        return
    strategies = load_ai_strategies()
    key = str(decision.get("strategy_key", ""))
    matched = next((item for item in strategies if item.get("strategy_key") == key and item.get("action") == action), None)
    if matched:
        matched["success_count"] = int(matched.get("success_count", 0)) + 1
        matched["last_success_at"] = datetime.now().astimezone().isoformat()
        matched["to_state"] = to_state
    else:
        strategies.append({
            "strategy_key": key,
            "state": from_state,
            "action": action,
            "reason": str(decision.get("reason", ""))[:300],
            "to_state": to_state,
            "success_count": 1,
            "last_success_at": datetime.now().astimezone().isoformat(),
        })
    maximum = max(1, int((CONFIG.get("aiRuntime") or {}).get("maxStrategyEntries", 200) or 200))
    try:
        AI_STRATEGY_PATH.parent.mkdir(parents=True, exist_ok=True)
        temporary = AI_STRATEGY_PATH.with_suffix(".tmp")
        temporary.write_text(json.dumps(strategies[-maximum:], ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(AI_STRATEGY_PATH)
        record("ai_strategy_learned", {"state": from_state, "to_state": to_state, "action": action, "strategy_key": key, "verified_by": "observed_state_transition"})
    except Exception as error:
        record("ai_strategy_learned", {"state": from_state, "to_state": to_state, "action": action, "strategy_key": key, "saved": False, "reason": str(error)[:300]})


def query_local_ai(snapshot_data, allowed_actions, context=None, timeout_seconds=60):
    runtime = CONFIG.get("aiRuntime") if isinstance(CONFIG.get("aiRuntime"), dict) else {}
    model = os.environ.get("ALPHA_RECOVERY_MODEL", str(runtime.get("model") or "alpha:9b")).strip() or "alpha:9b"
    ollama_base_url = (
        os.environ.get("ALPHA_OLLAMA_BASE_URL")
        or os.environ.get("OLLAMA_BASE_URL")
        or os.environ.get("OLLAMA_HOST")
        or "http://127.0.0.1:11435"
    ).strip().rstrip("/")
    if not ollama_base_url.startswith(("http://", "https://")):
        ollama_base_url = f"http://{ollama_base_url}"
    model_snapshot = dict(snapshot_data)
    image_base64 = str(model_snapshot.pop("_image_base64", "") or "")
    image_evidence_path = str(model_snapshot.pop("_image_evidence_path", "") or "")
    strategy_key = ai_strategy_key(model_snapshot)
    prompt = {
        "role": "ticket_runtime_supervisor",
        "snapshot": model_snapshot,
        "runtime_context": context or {},
        "allowed_actions": list(allowed_actions),
        "learned_strategies": matching_ai_strategies(strategy_key, snapshot_data.get("state")),
        "instruction": "You control this runtime; do not merely advise. Live DOM, visible_dialogs, network result, and the attached current browser frame are authoritative and require no image from the user. Return JSON only with action, diagnosis, reason, confidence, and next_expected_state. Choose one executable allowed action that advances the locked goal. Never request fields already present in locked_event, locked_schedule, wanted_count, allowed_zones, or runtime_context. Prefer a progress action over wait unless the snapshot proves waiting is required. If a prior action did not change the state or failure fingerprint, choose a different valid strategy instead of repeating it. Never change the locked event, performance, quantity, payment method, or allowed zones. Never solve CAPTCHA/OTP or submit payment.",
    }
    message = {"role": "user", "content": json.dumps(prompt, ensure_ascii=False)}
    if image_base64:
        message["images"] = [image_base64]
    keep_alive = runtime.get("keepAlive", "-1")
    if isinstance(keep_alive, str) and keep_alive.strip() == "-1":
        keep_alive = -1
    response_schema = {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": list(allowed_actions)},
            "diagnosis": {"type": "string"},
            "reason": {"type": "string"},
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            "next_expected_state": {"type": "string"},
        },
        "required": ["action", "diagnosis", "reason", "confidence", "next_expected_state"],
        "additionalProperties": False,
    }
    request = urllib.request.Request(
        f"{ollama_base_url}/api/chat",
        data=json.dumps({
            "model": model,
            "stream": False,
            "format": response_schema,
            "think": False,
            "keep_alive": keep_alive,
            "messages": [message],
            "options": {"temperature": 0, "num_ctx": 8192, "num_predict": 256},
        }).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=max(1, int(timeout_seconds))) as response:
            payload = json.loads(response.read().decode("utf-8"))
        raw_content = str((payload.get("message") or {}).get("content") or "{}")
        try:
            content = json.loads(raw_content)
        except json.JSONDecodeError:
            action_match = re.search(r'"action"\s*:\s*"([^"]+)"', raw_content)
            if not action_match:
                raise
            content = {"action": action_match.group(1), "diagnosis": "model selected a validated action before its explanation was truncated", "reason": "execute the selected action and verify the observed state transition", "confidence": 0.5, "next_expected_state": "state_changed"}
        action = str(content.get("action", ""))
        if action not in allowed_actions:
            raise ValueError("model returned an action outside the allowlist")
        result = {
            "action": action,
            "diagnosis": str(content.get("diagnosis", ""))[:500],
            "reason": str(content.get("reason", ""))[:500],
            "confidence": max(0.0, min(1.0, float(content.get("confidence", 0) or 0))),
            "next_expected_state": str(content.get("next_expected_state", ""))[:80],
            "model": model,
            "state": snapshot_data.get("state"),
            "strategy_key": strategy_key,
            "screenshot_included": bool(image_base64),
            "image_evidence_path": image_evidence_path,
        }
    except Exception as error:
        progressive_actions = [action for action in allowed_actions if action not in {"wait", "request_user", "notify_user", "stop"}]
        fallback = progressive_actions[0] if progressive_actions else allowed_actions[0]
        result = {"action": fallback, "diagnosis": "local AI unavailable", "reason": str(error)[:300], "confidence": 0.0, "next_expected_state": "", "model": model, "state": model_snapshot.get("state"), "strategy_key": strategy_key, "unavailable": True, "screenshot_included": bool(image_base64), "image_evidence_path": image_evidence_path}
    return result


def finalize_ai_runtime_analysis(strategy_key, future):
    global AI_LAST_DECISION
    with AI_LOCK:
        task = AI_FUTURES.get(strategy_key)
        if not task or task.get("future") is not future:
            return AI_LAST_DECISIONS.get(strategy_key)
        meta = dict(task.get("meta") or {})
    try:
        result = future.result()
    except Exception as error:
        result = {"action": "wait", "diagnosis": "advisor task failed", "reason": str(error)[:300], "confidence": 0.0, **meta}
    with AI_LOCK:
        current = AI_FUTURES.get(strategy_key)
        if current and current.get("future") is future:
            AI_FUTURES.pop(strategy_key, None)
        state = str(result.get("state") or meta.get("state") or "")
        stale = bool(AI_LAST_STATE and state and state != AI_LAST_STATE)
        result["stale"] = stale
        if not stale:
            AI_LAST_DECISION = result
        AI_LAST_DECISIONS[strategy_key] = result
        if state:
            AI_LAST_DECISIONS_BY_STATE[state] = result
    record("ai_analysis", {**result, "background": True, "credentials_included": False, "screenshot_included": bool(result.get("screenshot_included"))})
    return result


def collect_ai_runtime_analysis(wait_seconds=0, strategy_key=None):
    with AI_LOCK:
        if strategy_key:
            task = AI_FUTURES.get(strategy_key)
            cached = AI_LAST_DECISIONS.get(strategy_key)
        else:
            tasks = list(AI_FUTURES.items())
            task = None
            cached = AI_LAST_DECISION
    if strategy_key:
        if not task:
            return cached
        future = task.get("future")
        if wait_seconds <= 0 and not future.done():
            return cached
        try:
            future.result(timeout=max(0, wait_seconds))
        except FutureTimeoutError:
            return cached
        except Exception:
            pass
        return finalize_ai_runtime_analysis(strategy_key, future)
    for key, pending in tasks:
        future = pending.get("future")
        if future.done():
            finalize_ai_runtime_analysis(key, future)
    with AI_LOCK:
        return AI_LAST_DECISION


def schedule_ai_runtime_analysis(page, checkpoint, context=None):
    runtime = CONFIG.get("aiRuntime") if isinstance(CONFIG.get("aiRuntime"), dict) else {}
    collect_ai_runtime_analysis()
    if runtime.get("enabled", True) is False or runtime.get("analyzeEveryState", True) is False:
        return
    include_visual = bool((context or {}).get("visual_required"))
    if checkpoint.get("state") == "ticket_selection" and not bool((context or {}).get("seat_incident")):
        # The Fast Seat Engine owns the normal critical path. Alpha 9B is
        # scheduled only after live evidence identifies an incident.
        return
    incident = bool((context or {}).get("seat_incident"))
    if incident and not include_visual:
        snapshot_data = {
            "state": checkpoint.get("state"),
            "url": urlunsplit((*urlsplit(safe_page_url(page))[:3], "", "")),
            "body": "",
            "controls": [],
            "visible_dialogs": list((context or {}).get("visible_dialogs") or []),
            "seat_control_count": int((context or {}).get("candidate_count") or 0),
            "selected_count": int((context or {}).get("selected_count") or 0),
            "wanted_count": max(1, int(CONFIG.get("quantity", 1))),
            "current_zone": current_zone_from_page(page),
            "allowed_zones": expand_zone_preferences(CONFIG.get("_runtimeAvailableZones") or (CONFIG.get("seatRecovery") or {}).get("zoneOrder") or CONFIG.get("preferredZones", [])),
            "locked_event": str(CONFIG.get("eventName", ""))[:200],
            "locked_schedule": str(CONFIG.get("schedule", ""))[:120],
            "last_reservation_response": {"status": LATEST_RESERVATION_RESPONSE.get("status"), "url": urlunsplit((*urlsplit(str(LATEST_RESERVATION_RESPONSE.get("url") or ""))[:3], "", "")), "body": redact_ai_text(LATEST_RESERVATION_RESPONSE.get("body", ""))[:600]},
        }
    else:
        snapshot_data = sanitized_recovery_snapshot(page, checkpoint, include_visual=include_visual)
    strategy_key = ai_strategy_key(snapshot_data)
    now = time.monotonic()
    state = str(checkpoint.get("state") or "unknown")
    allowed_actions = ai_actions_for_state(checkpoint.get("state"))
    meta = {"state": checkpoint.get("state"), "strategy_key": strategy_key}
    with AI_LOCK:
        for pending_key, pending in list(AI_FUTURES.items()):
            pending_state = str((pending.get("meta") or {}).get("state") or "")
            if pending_state != state and pending.get("future") and pending["future"].cancel():
                AI_FUTURES.pop(pending_key, None)
        if strategy_key in AI_FUTURES or any(str((task.get("meta") or {}).get("state")) == state for task in AI_FUTURES.values()) or now - float(AI_LAST_SUBMITTED.get(strategy_key, 0)) < 5 or now - float(AI_LAST_STATE_SUBMITTED.get(state, 0)) < 8:
            return
        AI_LAST_SUBMITTED[strategy_key] = now
        AI_LAST_STATE_SUBMITTED[state] = now
        timeout_seconds = max(20, int(runtime.get("timeoutSeconds", 60) or 60)) if incident else min(15, max(8, int(runtime.get("timeoutSeconds", 60) or 60)))
        executor = AI_INCIDENT_EXECUTOR if incident else AI_EXECUTOR
        future = executor.submit(query_local_ai, snapshot_data, allowed_actions, context or {}, timeout_seconds)
        AI_FUTURES[strategy_key] = {"future": future, "meta": meta}
    future.add_done_callback(lambda completed, key=strategy_key: finalize_ai_runtime_analysis(key, completed))
    record("ai_analysis", {"status": "QUEUED", "state": checkpoint.get("state"), "allowed_actions": allowed_actions, "background": True, "critical_path_blocked": False, "screenshot_included": bool(snapshot_data.get("_image_base64"))})


def note_ai_state_transition(current_state):
    global AI_LAST_STATE
    previous = AI_LAST_STATE
    decision = AI_LAST_DECISIONS_BY_STATE.get(previous, {})
    if previous and previous != current_state and decision.get("state") == previous:
        remember_ai_strategy(decision, previous, current_state)
    AI_LAST_STATE = current_state


def request_ai_recovery_action(page, checkpoint, allowed_actions, context=None):
    """Use the all-state advisor result, waiting only when deterministic recovery is exhausted."""
    include_visual = bool((context or {}).get("visual_required"))
    recovery_snapshot = sanitized_recovery_snapshot(page, checkpoint, include_visual=include_visual)
    current_key = ai_strategy_key(recovery_snapshot)
    result = collect_ai_runtime_analysis(wait_seconds=20, strategy_key=current_key)
    if not result or result.get("strategy_key") != current_key or result.get("action") not in allowed_actions:
        result = query_local_ai(recovery_snapshot, allowed_actions, context or {})
        record("ai_analysis", {**result, "background": False, "credentials_included": False, "screenshot_included": bool(result.get("screenshot_included"))})
    record("recovery", {"status": "AI_RECOVERY_DECISION", **result, "credentials_included": False, "screenshot_included": bool(result.get("screenshot_included"))})
    return result


def execute_validated_ai_action(page, checkpoint, decision, confirm_order=False):
    """Execute only bounded actions against the locked run configuration."""
    action = str((decision or {}).get("action", ""))
    state = str(checkpoint.get("state", "unknown"))
    if action not in ai_actions_for_state(state):
        record("ai_action", {"state": state, "action": action, "validated": False, "executed": False, "detail": "action rejected by runtime allowlist", "payment_submitted": False})
        return False
    success = False
    detail = ""
    try:
        if action in {"rescan", "wait"}:
            wait_for_page_change(page, page.url, timeout_ms=1000)
            success = True
        elif action == "rescan_inventory":
            success = wait_for_inventory_change(page, int((CONFIG.get("seatRecovery") or {}).get("inventoryRescanIntervalMs", 750)))
        elif action == "reload_same_url" and state not in {"queue", "captcha_handoff", "otp_handoff", "payment_handoff"}:
            page.reload(wait_until="domcontentloaded", timeout=45000)
            success = True
        elif action == "activate_verified_control" and state == "waiting_room_entry":
            success = semantic_click(page, ["Join waiting room", "Join the queue", "Join queue", "เข้าห้องรอ", "กดรับคิว", "รับคิว"])
        elif action == "activate_locked_performance" and state in {"sale_entry", "zone_selection", "unknown"}:
            if state == "zone_selection":
                performance_state = ensure_locked_performance_on_booking_page(page)
                success = performance_state in {"matched", "changed", "absent"}
                detail = performance_state
            else:
                success = bool(activate_selected_performance(page, prefer_target_navigation=True))
        elif action == "return_seat_map" and state == "reservation_expired":
            success = return_to_same_seat_map(page)
        elif action == "fill_login" and state == "login":
            success = fill_login(page)
        elif action == "accept_terms" and state == "terms_conditions":
            success = accept_event_terms(page)
        elif action == "select_allowed_zone" and state == "zone_selection":
            success = select_preferred_zone(page)
        elif action == "apply_locked_quantity" and state == "quantity_selection":
            success = select_ticket_quantity(page)
        elif action == "fast_seat_engine" and state == "ticket_selection":
            success = bool(fast_reserved_seat_recovery(page).get("ok"))
        elif action == "dismiss_runtime_dialog" and state == "ticket_selection":
            success = dismiss_runtime_dialog(page)
        elif action == "release_partial" and state == "ticket_selection":
            success = release_partial_selection(page) == 0
        elif action == "switch_allowed_zone" and state == "ticket_selection":
            allowed = expand_zone_preferences(CONFIG.get("_runtimeAvailableZones") or (CONFIG.get("seatRecovery") or {}).get("zoneOrder") or CONFIG.get("preferredZones", []))
            current = current_zone_from_page(page)
            candidates = allowed[allowed.index(current) + 1:] if current in allowed else allowed
            success = bool(candidates and switch_to_allowed_zone(page, candidates[0]))
            detail = candidates[0] if candidates else "no remaining allowed zone"
        elif action == "fill_locked_attendees" and state == "attendee_details":
            success = fill_attendee_details(page)
        elif action == "apply_locked_checkout" and state == "checkout_options":
            success = bool(select_checkout_options(page, confirm_order=confirm_order))
        elif action in {"request_user", "notify_user", "stop"}:
            success = False
            detail = "human or terminal action"
        else:
            detail = "action rejected by runtime validator"
    except Exception as error:
        detail = str(error)[:300]
        success = False
    record("ai_action", {
        "state": state,
        "action": action,
        "validated": True,
        "executed": success,
        "detail": detail,
        "locked_event": CONFIG.get("eventName"),
        "locked_schedule": CONFIG.get("schedule"),
        "locked_quantity": CONFIG.get("quantity"),
        "payment_submitted": False,
    })
    return success


def execute_ready_ai_supervisor_action(page, checkpoint, confirm_order=False):
    """Execute a completed model decision instead of leaving it as UI advice.

    The seat and payment critical paths remain deterministic. For recoverable
    runtime states, a validated model action is applied in the live session and
    rate-limited so a stale decision cannot spam the page.
    """
    state = str(checkpoint.get("state", "unknown"))
    if state in {"ticket_selection", "payment_handoff", "queue", "captcha_handoff", "otp_handoff"}:
        return False
    decision = collect_ai_runtime_analysis()
    if not decision or str(decision.get("state", "")) != state:
        return False
    action = str(decision.get("action", ""))
    if action in {"", "wait", "request_user", "notify_user", "stop"}:
        return False
    strategy_key = str(decision.get("strategy_key", ""))
    execution_key = f"{state}:{strategy_key}:{action}"
    now = time.monotonic()
    if now - float(AI_ACTION_LAST_EXECUTED.get(execution_key, 0)) < 5:
        return False
    AI_ACTION_LAST_EXECUTED[execution_key] = now
    executed = execute_validated_ai_action(page, checkpoint, decision, confirm_order=confirm_order)
    record("supervisor_action", {"status": "AI_ACTION_EXECUTED" if executed else "AI_ACTION_FAILED", "state": state, "action": action, "strategy_key": strategy_key, "model_controlled": True, "payment_submitted": False})
    return executed


def autonomous_ai_recovery(page, checkpoint, allowed_actions, confirm_order=False, context=None):
    decision = request_ai_recovery_action(page, checkpoint, allowed_actions, context=context)
    executed = execute_validated_ai_action(page, checkpoint, decision, confirm_order=confirm_order)
    return {"decision": decision, "executed": executed}


def adaptive_retry_delay(checkpoint, attempt):
    retry_after = checkpoint.get("retry_after_seconds")
    configured = int((CONFIG.get("queue") or {}).get("retryAfterSeconds", 3) or 3)
    maximum = int((CONFIG.get("queue") or {}).get("maxBackoffSeconds", 30) or 30)
    return min(maximum, max(2, int(retry_after or configured), min(2 ** min(attempt, 5), maximum)))


def wait_for_payment_review(countdown_seconds=None):
    """Keep the QR browser alive until user input or the server hold countdown ends."""
    if countdown_seconds is None:
        console_input("ถึงหน้าชำระเงินจริงแล้ว ระบบหยุดก่อนจ่าย กด Enter เมื่อพี่ตรวจเสร็จ: ")
        return "user_done"
    deadline = time.monotonic() + max(0, int(countdown_seconds))
    while time.monotonic() < deadline:
        remaining = max(0, int(deadline - time.monotonic()))
        record("checkout_countdown", {"remaining_seconds": remaining, "payment_submitted": False})
        readable, _, _ = select.select([sys.stdin], [], [], min(5, max(0.1, remaining)))
        if readable:
            sys.stdin.readline()
            return "user_done"
    record("result", {"status": "ORDER_EXPIRED_AFTER_PAYMENT_HANDOFF", "payment_submitted": False, "live_checkout_verified": True})
    return "order_expired"


def return_to_same_seat_map(page):
    """Recover an expired hold without opening a new tab or changing performance."""
    for step in range(6):
        checkpoint = classify_snapshot(snapshot(page), sale_open_at=CONFIG.get("saleOpenAt", ""))
        if checkpoint["state"] in {"ticket_selection", "quantity_selection", "zone_selection"}:
            record("recovery", {"status": "RETURNED_TO_SEAT_FLOW", "state": checkpoint["state"], "steps": step, "same_session": True})
            return True
        previous_url = page.url
        try:
            page.go_back(wait_until="domcontentloaded", timeout=10000)
        except Exception:
            return False
        wait_for_page_change(page, previous_url, timeout_ms=2500)
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


def seconds_until(value):
    if not value:
        return None
    try:
        target = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return (target - datetime.now(target.tzinfo)).total_seconds()
    except (TypeError, ValueError, OverflowError):
        return None


def run_live(inspect_only=False, wait_for_window=False, confirm_order=False):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as runtime:
        browser_profile = pathlib.Path(os.environ.get("ALPHA_TICKET_BROWSER_PROFILE") or (ROOT / "browser-profile"))
        browser_profile.mkdir(parents=True, exist_ok=True)
        browser, context, cdp_port = launch_ticket_browser(runtime, browser_profile)
        record("runtime", {"mouse_control": False, "background_window": False, "browser_visible": True, "profile": "persistent_ticket_session", "transport": "cdp_attached_normal_chrome", "cdp_host": "127.0.0.1", "cdp_port": cdp_port, "detail": "เปิด Chrome แบบปกติแล้วเชื่อม Playwright ภายหลัง เพื่อแสดงทุกขั้นโดยไม่ขยับเมาส์ระบบ"})
        page = context.pages[-1] if context.pages else context.new_page()
        bind_navigation_observer(page)
        start_runtime_heartbeat(page)
        surface_browser_window(page, browser_profile, "runtime_started")
        observed = {"retry_after": None, "http_status": None, "server_date": None, "login_status": None}
        observed_api = set()
        login_submitted = False
        login_verified = False

        def on_response(response):
            global LATEST_RESERVATION_RESPONSE, LATEST_ZONE_AVAILABILITY_RESPONSE
            value = response.headers.get("retry-after")
            if value and str(value).isdigit():
                observed["retry_after"] = int(value)
            if response.request.resource_type == "document":
                observed["http_status"] = response.status
                observed["server_date"] = response.headers.get("date") or observed["server_date"]
            elif response.request.resource_type in {"xhr", "fetch"}:
                parsed = urlsplit(response.url)
                safe_url = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
                if re.search(r"check_user_signin|signin|login", parsed.path, re.I):
                    observed["login_status"] = response.status
                if re.search(r"seat|reserve|reservation|booking|ticket", parsed.path, re.I):
                    try:
                        response_text = response.text()
                    except Exception:
                        response_text = ""
                    LATEST_RESERVATION_RESPONSE = {
                        "status": response.status,
                        "url": safe_url,
                        "body": safe_response_excerpt(response_text),
                        "at": time.monotonic(),
                    }
                    RESERVATION_RESPONSE_HISTORY.append(dict(LATEST_RESERVATION_RESPONSE))
                    if len(RESERVATION_RESPONSE_HISTORY) > 100:
                        del RESERVATION_RESPONSE_HISTORY[:-100]
                    try:
                        zone_counts = normalize_zone_availability(json.loads(response_text)) if response_text else {}
                    except Exception:
                        zone_counts = {}
                    if zone_counts:
                        LATEST_ZONE_AVAILABILITY_RESPONSE = {"zones": zone_counts, "url": safe_url, "at": time.monotonic()}
                key = (response.request.method, safe_url, response.status)
                if key not in observed_api and len(observed_api) < 100:
                    observed_api.add(key)
                    record("api", {"method": response.request.method, "url": safe_url, "status": response.status, "resource_type": response.request.resource_type, "replayed": False})

        page.on("response", on_response)
        page.goto(CONFIG["eventUrl"], wait_until="domcontentloaded", timeout=45000)
        checkpoint = classify_snapshot(snapshot(page, observed["retry_after"], observed["http_status"], observed["server_date"]), sale_open_at=CONFIG.get("saleOpenAt", ""))
        record("checkpoint", {**checkpoint, "next_action": next_action(checkpoint), "live": True})
        if inspect_only:
            record("result", {"status": "INSPECTION_ONLY_NOT_FULL_LOOP", "state": checkpoint["state"], "reason": "ตรวจเฉพาะหน้าแรกและยังไม่ได้กดทางซื้อ", "live_checkout_verified": False})
            surface_browser_window(page, browser_profile, "inspection_only_review")
            record("input_required", {"field": "review", "stage": "inspection_only_review", "prompt": "เปิด Chrome ของบอทขึ้นหน้าแล้ว กดทำต่อหรือหยุดบอทเมื่อดูเสร็จ", "secret": False})
            console_input("ตรวจหน้าใน Chrome แล้วกลับมากด Enter เพื่อปิด หรือกดหยุดบอทจาก Alpha: ")
            context.close()
            return 0
        if checkpoint["state"] in {"pre_sale", "armed_pre_sale"} and not wait_for_window:
            record("result", {"status": "ARMED_PRE_SALE" if checkpoint["state"] == "armed_pre_sale" else "PRE_SALE_READY", "live_checkout_verified": False})
            context.close()
            return 0
        if checkpoint["state"] in {"pre_sale", "armed_pre_sale"}:
            wait_target = CONFIG.get("queueOpenAt") or CONFIG.get("saleOpenAt")
            target_remaining = seconds_until(wait_target)
            if checkpoint["state"] == "pre_sale" and (target_remaining is None or target_remaining > 30 * 60):
                status = "PRE_SALE_SCHEDULED" if target_remaining is not None else "PRE_SALE_TIME_UNVERIFIED"
                evidence_path = capture_status_evidence(page, status)
                record("result", {
                    "status": status,
                    "scheduled_for": wait_target or None,
                    "remaining_seconds": round(target_remaining, 1) if target_remaining is not None else None,
                    "relaunch_required": True,
                    "same_day_browser_hold": False,
                    "evidence_path": evidence_path,
                    "live_checkout_verified": False,
                })
                context.close()
                return 0
            wait_until(wait_target, "waiting_for_queue_window")
            page.reload(wait_until="domcontentloaded")
            checkpoint = classify_snapshot(snapshot(page, observed["retry_after"], observed["http_status"], observed["server_date"]), sale_open_at=CONFIG.get("saleOpenAt", ""))
            record("checkpoint", {**checkpoint, "next_action": next_action(checkpoint), "live": True})
        queue_rounds = 0
        access_denied_rounds = 0
        pre_sale_rounds = 0
        discovery_rounds = 0
        workflow_steps = 0
        unknown_recovery_rounds = 0
        recovery_failures = {}
        browser_recovery_rounds = 0
        login_retry_rounds = 0
        last_safe_url = safe_page_url(page, CONFIG["eventUrl"])
        last_safe_state = checkpoint.get("state", "unknown")
        while True:
            update_runtime_heartbeat_cache(page)
            checkpoint = classify_snapshot(snapshot(page, observed["retry_after"], observed["http_status"], observed["server_date"]), sale_open_at=CONFIG.get("saleOpenAt", ""))
            record("checkpoint", {**checkpoint, "next_action": next_action(checkpoint), "live": True})
            state = checkpoint["state"]
            if state == "browser_lost":
                if last_safe_state == "queue":
                    record("result", {
                        "status": "BROWSER_LOST_DURING_ACTIVE_QUEUE",
                        "live_checkout_verified": False,
                        "same_queue_position_preserved": False,
                        "reason": "browser process exited; active queue must not be refreshed or silently replaced",
                    })
                    return 4
                browser_recovery_rounds += 1
                if browser_recovery_rounds > 3:
                    record("result", {"status": "BROWSER_RECOVERY_EXHAUSTED", "live_checkout_verified": False, "last_safe_state": last_safe_state, "last_safe_url": last_safe_url})
                    return 4
                record("recovery", {
                    "status": "BROWSER_RELAUNCH_STARTED",
                    "attempt": browser_recovery_rounds,
                    "last_safe_state": last_safe_state,
                    "same_profile": True,
                    "target_url": last_safe_url,
                })
                try:
                    context.close()
                except Exception:
                    pass
                stop_owned_browser()
                try:
                    browser, context, cdp_port = launch_ticket_browser(runtime, browser_profile)
                    page = context.pages[-1] if context.pages else context.new_page()
                    bind_navigation_observer(page)
                    start_runtime_heartbeat(page)
                    page.on("response", on_response)
                    page.goto(last_safe_url or CONFIG["eventUrl"], wait_until="domcontentloaded", timeout=45000)
                    surface_browser_window(page, browser_profile, "browser_recovered")
                    record("recovery", {"status": "BROWSER_RELAUNCHED", "attempt": browser_recovery_rounds, "same_profile": True, "url": safe_page_url(page), "cdp_port": cdp_port})
                    continue
                except Exception as error:
                    record("recovery", {"status": "BROWSER_RELAUNCH_FAILED", "attempt": browser_recovery_rounds, "error": str(error)[:500], "terminal": False})
                    continue
            browser_recovery_rounds = 0
            last_safe_url = safe_page_url(page, last_safe_url)
            last_safe_state = state
            collect_ai_runtime_analysis()
            note_ai_state_transition(state)
            schedule_ai_runtime_analysis(page, checkpoint, {
                "workflow_steps": workflow_steps,
                "queue_rounds": queue_rounds,
                "access_denied_rounds": access_denied_rounds,
                "login_verified": login_verified,
                "confirm_unpaid_order_authorized": confirm_order,
            })
            if execute_ready_ai_supervisor_action(page, checkpoint, confirm_order=confirm_order):
                continue
            if not login_verified and (authenticated_account_marker(page) or authenticated_booking_session(page, state)):
                login_verified = True
                record("authentication", {"status": "EXISTING_SESSION_VERIFIED", "method": "account_marker_or_private_booking_step", "credentials_persisted": False})
            if login_submitted and state not in {"login", "captcha_handoff", "otp_handoff", "unknown", "server_unavailable"} and not login_verified:
                login_verified = True
                record("authentication", {"status": "LOGIN_VERIFIED", "method": "successful_form_transition", "credentials_persisted": False})
            if state not in {"pre_sale", "armed_pre_sale", "queue", "server_unavailable", "unknown"}:
                workflow_steps += 1
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
                unknown_recovery_rounds += 1
                if unknown_recovery_rounds % 4 == 0:
                    recovery = autonomous_ai_recovery(page, checkpoint, ["rescan", "reload_same_url", "wait", "request_user"], context={"failure": "runtime_layout_not_classified", "round": unknown_recovery_rounds})
                    if recovery["executed"]:
                        continue
                    if recovery["decision"].get("action") == "request_user":
                        surface_browser_window(page, browser_profile, "waiting_unknown_layout")
                        record("input_required", {"field": "unknown_layout", "stage": "waiting_unknown_layout", "prompt": "รูปแบบหน้าเว็บเปลี่ยนและ recovery ปกติระบุขั้นต่อไปไม่ได้ กรุณาตรวจหน้าเดิมแล้วกดทำต่อ", "secret": False})
                        console_input("ตรวจหน้าเดิมแล้วกด Enter เพื่อให้ AI rescan ด้วย session เดิม: ")
                        continue
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
            if state == "unknown":
                unknown_recovery_rounds += 1
                recovery = autonomous_ai_recovery(page, checkpoint, ["rescan", "reload_same_url", "wait", "request_user"], context={"failure": "unknown_state", "round": unknown_recovery_rounds})
                if recovery["executed"]:
                    continue
                surface_browser_window(page, browser_profile, "waiting_unknown_layout")
                record("input_required", {"field": "unknown_layout", "stage": "waiting_unknown_layout", "prompt": "AI ระบุขั้นต่อไปจากหลักฐานไม่ได้ กรุณาตรวจหน้าเดิมแล้วกดทำต่อ", "secret": False})
                console_input("ตรวจหน้าเดิมแล้วกด Enter เพื่อ rescan: ")
                continue
            if state == "waiting_room_entry":
                selected_queue_entry = CONFIG.get("selectedPerformance") if isinstance(CONFIG.get("selectedPerformance"), dict) else {}
                previous_url = page.url
                activated_page = activate_selected_performance(page) if selected_queue_entry else None
                activated = bool(activated_page) if selected_queue_entry else semantic_click(page, ["Join waiting room", "Join the queue", "Join queue", "เข้าห้องรอ", "กดรับคิว", "รับคิว"])
                if not activated:
                    refreshed = classify_snapshot(snapshot(page, observed["retry_after"], observed["http_status"], observed["server_date"]), sale_open_at=CONFIG.get("saleOpenAt", ""))
                    record("recovery", {"status": "WAITING_ROOM_CONTROL_CHANGED", "previous_state": state, "current_state": refreshed["state"], "actionable_control_count": refreshed.get("actionable_control_count", 0)})
                    if refreshed["state"] != "waiting_room_entry":
                        checkpoint = refreshed
                        wait_for_page_change(page, previous_url, timeout_ms=500)
                        continue
                    recovery_failures[state] = recovery_failures.get(state, 0) + 1
                    recovery = autonomous_ai_recovery(page, checkpoint, ["activate_verified_control", "rescan", "wait", "reload_same_url", "request_user"], context={"failure": "waiting_room_control_changed", "attempt": recovery_failures[state]})
                    if recovery["executed"]:
                        continue
                    surface_browser_window(page, browser_profile, "waiting_queue_recovery")
                    record("input_required", {"field": "queue_recovery", "stage": "waiting_queue_recovery", "prompt": "AI วิเคราะห์แล้วแต่ยังยืนยันปุ่มรับคิวไม่ได้ ระบบรักษา session เดิมไว้ให้ตรวจ", "secret": False})
                    console_input("ตรวจหน้าคิวเดิมแล้วกด Enter เพื่อให้ AI วิเคราะห์ต่อ: ")
                    continue
                if activated_page:
                    page = activated_page
                    bind_navigation_observer(page)
                record("queue", {"status": "WAITING_ROOM_JOINED", "clicked_once": True, "same_session": True, "selected_schedule": CONFIG.get("schedule"), "selected_performance": CONFIG.get("selectedPerformance")})
                wait_for_page_change(page, previous_url, timeout_ms=5000)
                continue
            if state in {"queue", "server_unavailable"}:
                queue_rounds += 1
                wait_seconds = checkpoint.get("retry_after_seconds") or CONFIG["queue"]["retryAfterSeconds"]
                wait_seconds = min(CONFIG["queue"]["maxBackoffSeconds"], max(2, wait_seconds))
                if state == "queue":
                    record("queue_analysis", {
                        "queue_position": checkpoint.get("queue_position"),
                        "queue_position_verified": checkpoint.get("queue_position_verified", False),
                        "waited_seconds": queue_rounds * wait_seconds,
                        "server_status": observed.get("http_status"),
                        "current_action": "preserve_active_queue_session",
                        "next_action": "wait_for_server_auto_update",
                        "page_refresh": False,
                    })
                    record("wait", {"state": state, "seconds": wait_seconds, "same_session": True, "round": queue_rounds, "page_refresh": False, "auto_update": True, "queue_position": checkpoint.get("queue_position"), "queue_position_verified": checkpoint.get("queue_position_verified", False)})
                    page.wait_for_timeout(wait_seconds * 1000)
                else:
                    record("wait", {"state": state, "seconds": wait_seconds, "same_session": True, "round": queue_rounds, "page_refresh": True})
                    time.sleep(wait_seconds)
                    page.reload(wait_until="domcontentloaded")
                continue
            if state == "sale_entry":
                previous_url = page.url
                activated_page = activate_selected_performance(page, prefer_target_navigation=True)
                if not activated_page:
                    recovery_failures[state] = recovery_failures.get(state, 0) + 1
                    record("recovery", {"status": "SELECTED_PERFORMANCE_NOT_AVAILABLE", "reason": "ไม่พบ control ที่ตรงกับวัน/เวลาที่ล็อกไว้", "selected_performance": CONFIG.get("selectedPerformance"), "same_queue_session": True, "terminal": False})
                    recovery = autonomous_ai_recovery(page, checkpoint, ["activate_locked_performance", "rescan", "wait", "reload_same_url", "request_user"], context={"failure": "locked_performance_control_missing", "attempt": recovery_failures[state]})
                    if recovery["executed"]:
                        continue
                    surface_browser_window(page, browser_profile, "waiting_selected_performance")
                    record("input_required", {"field": "performance", "stage": "waiting_selected_performance", "prompt": "AI ยังหารอบที่ล็อกไว้ไม่พบ ระบบไม่เลือกรอบอื่นแทนและรักษา session เดิมไว้", "secret": False})
                    console_input("ตรวจรอบใน Chrome แล้วกด Enter เพื่อให้ AI วิเคราะห์ต่อ โดยไม่เปลี่ยนรอบ: ")
                    continue
                page = activated_page
                bind_navigation_observer(page)
                wait_for_page_change(page, previous_url, timeout_ms=5000)
                continue
            if state == "sale_closed":
                evidence_path = capture_status_evidence(page, "SALE_CLOSED_BY_SERVER")
                record("result", {"status": "SALE_CLOSED_BY_SERVER", "live_checkout_verified": False, "url": page.url, "evidence_path": evidence_path})
                context.close()
                return 0
            if state == "sold_out":
                evidence_path = capture_status_evidence(page, "SOLD_OUT_BY_SERVER")
                record("result", {"status": "SOLD_OUT_BY_SERVER", "live_checkout_verified": False, "url": page.url, "evidence_path": evidence_path})
                context.close()
                return 0
            if state == "access_denied":
                access_denied_rounds += 1
                if access_denied_rounds == 1:
                    surface_browser_window(page, browser_profile, "waiting_access_denied")
                    record("browser_state", {"field": "access_denied", "stage": "waiting_access_denied", "prompt": "เซิร์ฟเวอร์ปฏิเสธคำขอชั่วคราว บอทจะแสดงหน้าต่างเดิมและ retry โดยรักษา session", "same_session": True, "new_tab": False})
                wait_seconds = adaptive_retry_delay(checkpoint, access_denied_rounds)
                record("recovery", {"status": "ACCESS_DENIED_RETRY_SCHEDULED", "attempt": access_denied_rounds, "seconds": wait_seconds, "same_session": True, "same_url": True, "retry_after_honored": checkpoint.get("retry_after_seconds") is not None, "new_tab": False})
                time.sleep(wait_seconds)
                page.reload(wait_until="domcontentloaded")
                continue
            if state == "reservation_expired":
                record("recovery", {"status": "SEAT_HOLD_EXPIRED", "next_action": "return_to_same_seat_map", "same_session": True})
                if return_to_same_seat_map(page):
                    continue
                surface_browser_window(page, browser_profile, "waiting_reservation_recovery")
                record("input_required", {"field": "reservation_recovery", "stage": "waiting_reservation_recovery", "prompt": "ที่นั่งหลุดและระบบย้อนกลับผังเดิมไม่ได้ กรุณากลับหน้าผังใน browser เดิมแล้วกดทำต่อ", "secret": False})
                console_input("กลับไปหน้าผังที่นั่งใน Chrome เดิมแล้วกด Enter: ")
                continue
            if state == "login":
                login_url = page.url
                observed["http_status"] = None
                observed["login_status"] = None
                login_ready = fill_login(page)
                if login_ready is None:
                    record("recovery", {"status": "LOGIN_FORM_RESCAN", "same_session": True, "user_input_required": False})
                    continue
                if not login_ready:
                    surface_browser_window(page, browser_profile, "waiting_login_form")
                    record("input_required", {"field": "login", "stage": "waiting_login_form", "prompt": "ฟอร์ม Login เปลี่ยนหรือข้อมูลยังไม่ครบ กรุณาตรวจหน้าเดิมแล้วส่งข้อมูลใหม่", "secret": False})
                    console_input("ตรวจ/กรอก Login ใน Chrome เดิมแล้วกด Enter เพื่อ rescan: ")
                    continue
                login_submitted = True
                transitioned = wait_for_post_login_transition(page, login_url)
                after_login = classify_snapshot(snapshot(page, observed["retry_after"], observed["http_status"], observed["server_date"]), sale_open_at=CONFIG.get("saleOpenAt", ""))
                record("authentication", {"status": "POST_LOGIN_SETTLED" if transitioned else "POST_LOGIN_TIMEOUT", "from_url": login_url, "to_url": page.url, "state": after_login["state"], "credentials_persisted": False})
                if after_login["state"] == "login":
                    login_status = observed.get("login_status")
                    if login_status in {403, 408, 409, 425, 428, 429, 503} or login_status is None:
                        login_retry_rounds += 1
                        wait_seconds = min(5, 1 + login_retry_rounds)
                        record("recovery", {"status": "LOGIN_SECURITY_CHALLENGE_RETRY", "http_status": login_status, "attempt": login_retry_rounds, "seconds": wait_seconds, "same_session": True, "credentials_retained": True, "user_input_required": False})
                        page.wait_for_timeout(wait_seconds * 1000)
                        login_submitted = False
                        continue
                    os.environ.pop("TICKET_USERNAME", None)
                    os.environ.pop("TICKET_PASSWORD", None)
                    record("input_required", {"field": "login", "stage": "waiting_login_retry", "prompt": "Login ยังไม่สำเร็จ ระบบรักษา session ไว้และรอข้อมูลใหม่", "secret": False})
                    console_input("Login ยังไม่สำเร็จ ตรวจข้อความใน Chrome แล้วกด Enter เพื่อกรอกใหม่: ")
                    login_submitted = False
                    continue
                login_retry_rounds = 0
                continue
            if state in {"captcha_handoff", "otp_handoff"}:
                if state == "captcha_handoff" and login_submitted:
                    previous_url = page.url
                    wait_for_post_login_transition(page, previous_url, timeout_ms=5000)
                    refreshed = classify_snapshot(snapshot(page, observed["retry_after"], observed["http_status"], observed["server_date"]), sale_open_at=CONFIG.get("saleOpenAt", ""))
                    if refreshed["state"] != "captcha_handoff":
                        record("recovery", {"status": "POST_LOGIN_REDIRECT_COMPLETED", "previous_state": state, "current_state": refreshed["state"], "url": page.url})
                        continue
                record("handoff", {"status": state.upper(), "resume_supported": True, "same_session": True})
                handoff_stage = "waiting_captcha" if state == "captcha_handoff" else "waiting_otp"
                surface_browser_window(page, browser_profile, handoff_stage)
                record("input_required", {"field": "captcha" if state == "captcha_handoff" else "otp", "stage": handoff_stage, "prompt": "เปิด Chrome ของบอทขึ้นหน้าแล้ว แก้ขั้นยืนยันและกลับมากดทำต่อ", "secret": False})
                console_input("รับช่วงในหน้าต่าง Chrome เฉพาะขั้นนี้ แล้วกลับมากด Enter; บอทจะทำงานต่อด้วย session เดิม: ")
                wait_for_page_change(page, page.url, timeout_ms=1500)
                continue
            if state == "terms_conditions":
                previous_url = page.url
                if not accept_event_terms(page):
                    recovery_failures[state] = recovery_failures.get(state, 0) + 1
                    recovery = autonomous_ai_recovery(page, checkpoint, ["accept_terms", "rescan", "wait", "request_user"], context={"failure": "terms_control_changed", "attempt": recovery_failures[state]})
                    if recovery["executed"]:
                        continue
                    surface_browser_window(page, browser_profile, "waiting_terms_recovery")
                    record("input_required", {"field": "terms", "stage": "waiting_terms_recovery", "prompt": "AI ยังยืนยัน control ข้อตกลงไม่ได้ ระบบรักษา session ไว้ให้ตรวจ", "secret": False})
                    console_input("ตรวจหน้าข้อตกลงแล้วกด Enter เพื่อให้ AI วิเคราะห์ต่อ: ")
                    continue
                record("action", {"action": "terms_accepted_under_run_authorization", "same_session": True})
                wait_for_page_change(page, previous_url, timeout_ms=5000)
                continue
            if state == "zone_selection":
                performance_state = ensure_locked_performance_on_booking_page(page)
                if performance_state == "changed":
                    continue
                if performance_state == "missing":
                    recovery_failures["repeat_performance"] = recovery_failures.get("repeat_performance", 0) + 1
                    recovery = autonomous_ai_recovery(page, checkpoint, ["activate_locked_performance", "rescan", "wait", "request_user"], context={
                        "failure": "repeat_performance_selector_does_not_match_locked_schedule",
                        "attempt": recovery_failures["repeat_performance"],
                        "locked_schedule": CONFIG.get("schedule"),
                    })
                    if recovery["executed"]:
                        continue
                    surface_browser_window(page, browser_profile, "waiting_repeat_performance")
                    record("input_required", {"field": "performance", "stage": "waiting_repeat_performance", "prompt": "หน้า Booking ให้เลือกรอบอีกครั้ง แต่ยังจับคู่รอบที่ล็อกไว้ไม่ได้ ระบบไม่เลือกรอบอื่นแทน", "secret": False})
                    console_input("ตรวจตัวเลือกรอบใน Chrome เดิมแล้วกด Enter เพื่อให้ AI วิเคราะห์ต่อ: ")
                    continue
                previous_url = page.url
                if not select_preferred_zone(page):
                    zone_failure_reason = CONFIG.pop("_runtimeLastZoneSelectionReason", "")
                    if zone_failure_reason == "AVAILABILITY_UNAVAILABLE":
                        record("recovery", {"status": "WAITING_FOR_ZONE_AVAILABILITY", "same_session": True, "retry_without_user": True, "delay_ms": 750})
                        page.wait_for_timeout(750)
                        continue
                    recovery_failures[state] = recovery_failures.get(state, 0) + 1
                    recovery = autonomous_ai_recovery(page, checkpoint, ["select_allowed_zone", "rescan", "wait", "request_user"], context={"failure": "allowed_zone_control_missing", "attempt": recovery_failures[state], "allowed_zones": CONFIG.get("preferredZones", [])})
                    if recovery["executed"]:
                        continue
                    surface_browser_window(page, browser_profile, "waiting_zone_recovery")
                    record("input_required", {"field": "zone", "stage": "waiting_zone_recovery", "prompt": "AI ยังเลือกได้เฉพาะโซนที่อนุญาตแต่หา control ไม่พบ ระบบไม่ออกนอกโซน", "secret": False})
                    console_input("ตรวจหน้าโซนเดิมแล้วกด Enter เพื่อให้ AI วิเคราะห์ต่อ: ")
                    continue
                wait_for_page_change(page, previous_url, timeout_ms=5000)
                continue
            if state == "quantity_selection":
                previous_url = page.url
                if not select_ticket_quantity(page):
                    recovery_failures[state] = recovery_failures.get(state, 0) + 1
                    recovery = autonomous_ai_recovery(page, checkpoint, ["apply_locked_quantity", "rescan", "wait", "request_user"], context={"failure": "quantity_control_changed", "attempt": recovery_failures[state], "locked_quantity": CONFIG.get("quantity")})
                    if recovery["executed"]:
                        continue
                    surface_browser_window(page, browser_profile, "waiting_quantity_recovery")
                    record("input_required", {"field": "quantity", "stage": "waiting_quantity_recovery", "prompt": "AI ยังใส่จำนวนบัตรที่ล็อกไว้ไม่ได้ ระบบไม่เปลี่ยนจำนวนเอง", "secret": False})
                    console_input("ตรวจหน้าจำนวนบัตรแล้วกด Enter เพื่อให้ AI วิเคราะห์ต่อ: ")
                    continue
                wait_for_page_change(page, previous_url, timeout_ms=5000)
                after_quantity = classify_snapshot(snapshot(page, observed["retry_after"], observed["http_status"], observed["server_date"]), sale_open_at=CONFIG.get("saleOpenAt", ""))
                if safe_page_url(page) != previous_url and after_quantity["state"] in {"attendee_details", "checkout_options", "payment_handoff"}:
                    record("reservation_verified", {
                        "status": "GENERAL_ADMISSION_HOLD_VERIFIED",
                        "mode": "quantity",
                        "selected": max(1, int(CONFIG.get("quantity", 1))),
                        "wanted": max(1, int(CONFIG.get("quantity", 1))),
                        "verification": "server advanced from festival quantity page to the next private checkout step",
                        "reservation_token_fingerprint": reservation_token_fingerprint(page),
                    })
                continue
            if state == "ticket_selection":
                previous_url = page.url
                seat_result = apply_ticket_preferences(page)
                if not seat_result.get("ok"):
                    terminal = seat_result.get("terminal")
                    if terminal == "state_changed":
                        record("recovery", {"status": "SEAT_ENGINE_RETURNED_CONTROL", "state": seat_result.get("state"), "terminal": False, "preserved_preferences": True})
                        continue
                    if terminal == "browser_lost":
                        record("recovery", {"status": "BROWSER_LOST_RETURN_TO_MAIN_LOOP", "terminal": False, "same_profile": True})
                        continue
                    if terminal == "captcha_handoff":
                        surface_browser_window(page, browser_profile, "waiting_captcha")
                        record("input_required", {"field": "captcha", "stage": "waiting_captcha", "prompt": "พบ CAPTCHA ที่ผังที่นั่ง เปิด Chrome ของบอทขึ้นหน้าแล้ว แก้ขั้นยืนยันและกดทำต่อ", "secret": False})
                        console_input("แก้ CAPTCHA ใน Chrome เดิมแล้วกด Enter; บอทจะสแกนผังต่อด้วย session เดิม: ")
                        continue
                    if terminal == "visual_handoff":
                        surface_browser_window(page, browser_profile, "waiting_visual_seat_recovery")
                        record("input_required", {"field": "seat_layout", "stage": "waiting_visual_seat_recovery", "prompt": "AI Vision วิเคราะห์ผังแล้วแต่ยังไม่มี action ที่ตรวจสอบได้ ระบบคง session และโซนเดิมไว้", "secret": False, "ai_decision": seat_result.get("ai_decision")})
                        console_input("ตรวจผังใน Chrome เดิมแล้วกด Enter เพื่อให้ AI วิเคราะห์ภาพใหม่: ")
                        continue
                    if terminal in {"sold_out", "sale_closed"}:
                        evidence_path = capture_status_evidence(page, terminal.upper())
                        record("result", {"status": "SOLD_OUT_BY_SERVER" if terminal == "sold_out" else "SALE_CLOSED_BY_SERVER", "wanted": CONFIG.get("quantity"), "evidence_path": evidence_path, "live_checkout_verified": False})
                        context.close()
                        return 0
                    recovery_failures[state] = recovery_failures.get(state, 0) + 1
                    recovery = autonomous_ai_recovery(page, checkpoint, ["rescan_inventory", "release_partial", "switch_allowed_zone", "fast_seat_engine", "request_user"], context={"failure": terminal or "seat_recovery_unresolved", "attempt": recovery_failures[state], "wanted": CONFIG.get("quantity")})
                    if recovery["executed"]:
                        continue
                    surface_browser_window(page, browser_profile, "waiting_seat_recovery")
                    record("input_required", {"field": "seat_recovery", "stage": "waiting_seat_recovery", "prompt": "AI ยังแก้ผังที่นั่งรูปแบบนี้ไม่ได้ ระบบรักษา session และชุดเงื่อนไขเดิมไว้", "secret": False})
                    console_input("ตรวจผังเดิมแล้วกด Enter เพื่อให้ AI วิเคราะห์ต่อ: ")
                    continue
                continued = semantic_click(page, ["ดำเนินการต่อ", "ถัดไป", "continue", "next", "ยืนยัน"])
                if not continued:
                    record("recovery", {"status": "CONTINUE_CONTROL_RESCAN", "same_session": True, "reservation_preserved": True})
                    recovery = autonomous_ai_recovery(page, checkpoint, ["rescan", "wait", "request_user"], context={"failure": "continue_control_changed", "reservation_verified": True})
                    if not recovery["executed"]:
                        surface_browser_window(page, browser_profile, "waiting_manual_continue")
                        record("input_required", {"field": "continue", "stage": "waiting_manual_continue", "prompt": "ที่นั่งถูกยืนยันแล้วแต่ปุ่มดำเนินการต่อเปลี่ยน กรุณากดปุ่มต่อใน Chrome แล้วกดทำต่อ", "secret": False})
                        console_input("กดดำเนินการต่อใน Chrome เดิมแล้วกลับมากด Enter: ")
                wait_for_page_change(page, previous_url, timeout_ms=5000)
                after_seat = classify_snapshot(snapshot(page, observed["retry_after"], observed["http_status"], observed["server_date"]), sale_open_at=CONFIG.get("saleOpenAt", ""))
                pending_acceptance = CONFIG.get("_runtimePendingServerSeatAcceptance")
                if isinstance(pending_acceptance, dict) and after_seat["state"] in {"terms_conditions", "attendee_details", "checkout_options", "payment_handoff"}:
                    record("reservation_verified", {
                        **pending_acceptance,
                        "status": "SEAT_HOLD_VERIFIED",
                        "verification": "server accepted the exact seat set and advanced to a private checkout state",
                        "advanced_state": after_seat["state"],
                        "reservation_token_fingerprint": reservation_token_fingerprint(page) or pending_acceptance.get("reservation_token_fingerprint", ""),
                    })
                    CONFIG.pop("_runtimePendingServerSeatAcceptance", None)
                elif isinstance(pending_acceptance, dict) and after_seat["state"] == "ticket_selection":
                    record("recovery", {
                        "status": "SERVER_ACCEPTED_SET_AWAITING_CONTINUE_TRANSITION",
                        "wanted": pending_acceptance.get("wanted"),
                        "accepted_response_count": pending_acceptance.get("accepted_response_count"),
                        "duplicate_click_prevented": True,
                        "terminal": False,
                        "next_action": "retry_continue_without_selecting_more_seats",
                    })
                continue
            if state == "attendee_details":
                previous_url = page.url
                if not fill_attendee_details(page):
                    recovery_failures[state] = recovery_failures.get(state, 0) + 1
                    recovery = autonomous_ai_recovery(page, checkpoint, ["fill_locked_attendees", "rescan", "wait", "request_user"], context={"failure": "attendee_form_changed", "attempt": recovery_failures[state], "values_locked": True})
                    if recovery["executed"]:
                        continue
                    surface_browser_window(page, browser_profile, "waiting_attendee_recovery")
                    record("input_required", {"field": "attendee", "stage": "waiting_attendee_recovery", "prompt": "AI ยังจับคู่ฟิลด์ข้อมูลผู้เข้าชมไม่ได้ ระบบไม่เดาค่าหรือเปลี่ยนผู้เข้าชม", "secret": False})
                    console_input("ตรวจฟอร์มผู้เข้าชมแล้วกด Enter เพื่อให้ AI วิเคราะห์ต่อ: ")
                    continue
                wait_for_page_change(page, previous_url, timeout_ms=5000)
                continue
            if state == "checkout_options":
                if not login_verified:
                    record("result", {"status": "LOGIN_REQUIRED_BEFORE_CHECKOUT", "live_checkout_verified": False, "credentials_persisted": False})
                    context.close()
                    return 2
                previous_url = page.url
                checkout_result = select_checkout_options(page, confirm_order=confirm_order)
                if checkout_result is None:
                    surface_browser_window(page, browser_profile, "waiting_checkout_options")
                    record("input_required", {"field": "checkout_options", "stage": "waiting_checkout_options", "prompt": "เปิด Chrome ของบอทขึ้นหน้าแล้ว เลือกวิธีรับบัตร/QR และกดทำต่อ", "secret": False})
                    console_input("เลือกวิธีรับบัตร/QR แล้ว ระบบหยุดก่อนสร้างคำสั่งซื้อ กด Enter เพื่อปิด หรือรันใหม่ด้วย --confirm-order: ")
                    context.close()
                    return 0
                if not checkout_result:
                    recovery_failures[state] = recovery_failures.get(state, 0) + 1
                    recovery = autonomous_ai_recovery(page, checkpoint, ["apply_locked_checkout", "rescan", "wait", "request_user"], confirm_order=confirm_order, context={"failure": "checkout_controls_changed", "attempt": recovery_failures[state], "payment_method_locked": CONFIG.get("paymentMethod")})
                    if recovery["executed"]:
                        continue
                    surface_browser_window(page, browser_profile, "waiting_checkout_recovery")
                    record("input_required", {"field": "checkout_options", "stage": "waiting_checkout_recovery", "prompt": "AI ยังจับคู่ตัวเลือก Checkout ไม่ได้ ระบบไม่เปลี่ยนวิธีรับบัตรหรือวิธีชำระ", "secret": False})
                    console_input("ตรวจ Checkout เดิมแล้วกด Enter เพื่อให้ AI วิเคราะห์ต่อ: ")
                    continue
                wait_for_page_change(page, previous_url, timeout_ms=5000)
                continue
            if state == "payment_handoff":
                if not login_verified:
                    record("result", {"status": "LOGIN_REQUIRED_BEFORE_PAYMENT", "live_checkout_verified": False, "credentials_persisted": False})
                    context.close()
                    return 2
                evidence_path = capture_status_evidence(page, "PAYMENT_HANDOFF")
                countdown_match = re.search(r"(?:remaining\s*time|เหลือเวลา|ภายในเวลา)\D{0,30}(\d{1,2})(?::(\d{2}))?", str(snapshot(page).get("body", "")), re.I)
                countdown_seconds = (int(countdown_match.group(1)) * 60 + int(countdown_match.group(2) or 0)) if countdown_match else None
                record("result", {"status": "PAYMENT_HANDOFF", "login_verified": True, "live_checkout_verified": verified_payment_handoff(checkpoint), "payment_not_submitted": True, "payment_evidence_count": checkpoint.get("payment_evidence_count"), "checkout_countdown_seconds": countdown_seconds, "evidence_path": evidence_path})
                surface_browser_window(page, browser_profile, "payment_handoff")
                record("input_required", {"field": "payment", "stage": "payment_handoff", "prompt": "เปิด Chrome ของบอทขึ้นหน้าแล้ว: ถึงหน้าชำระเงินจริง ระบบหยุดก่อนจ่าย", "secret": False})
                wait_for_payment_review(countdown_seconds)
                context.close()
                return 0
            break
        record("result", {"status": "STOPPED_WITHOUT_VERIFIED_PAYMENT_HANDOFF", "state": checkpoint["state"], "live_checkout_verified": False})
        surface_browser_window(page, browser_profile, "waiting_review")
        record("input_required", {"field": "review", "stage": "waiting_review", "prompt": "เปิด Chrome ของบอทขึ้นหน้าแล้ว: หลักฐานยังไม่พอ ตรวจแล้วกดทำต่อเพื่อปิด", "secret": False})
        console_input("หลักฐานยังไม่พอ ระบบหยุดไว้ให้ตรวจใน Chrome กด Enter เพื่อปิด: ")
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
    try:
        exit_code = run_live(args.inspect_only, args.wait_for_window, args.confirm_order)
    finally:
        stop_owned_browser()
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
'''

    test_source = r'''import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from state_machine import choose_seat_indices, classify_snapshot, expand_zone_preferences, next_action, verified_payment_handoff


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
        self.assertEqual(next_action(result), "keep_same_session_and_retry_adaptively")

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

    def test_round_and_ticket_type_control_is_sale_entry(self):
        result = self.state("ON SALE NOW", controls=["เลือกรอบ/ประเภทบัตร"])
        self.assertEqual(result["state"], "sale_entry")
        self.assertEqual(next_action(result), "activate_verified_purchase_control")

    def test_visible_sale_entry_wins_over_generic_terms_copy(self):
        result = self.state("ON SALE NOW conditions เงื่อนไขข้อตกลง", controls=["เลือกรอบ/ประเภทบัตร"])
        self.assertEqual(result["state"], "sale_entry")

    def test_round_section_control_does_not_skip_pre_sale_queue_window(self):
        result = self.state("COMING SOON เปิดขายวันพรุ่งนี้", controls=["เลือกรอบ/ประเภทบัตร"])
        self.assertEqual(result["state"], "pre_sale")

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

    def test_captcha_before_waiting_room_wins_over_queue_control(self):
        result = self.state("Security check CAPTCHA YOU ARE NOW IN THE ENTRY ZONE", controls=["Join waiting room"])
        self.assertEqual(result["state"], "captcha_handoff")
        self.assertEqual(next_action(result), "user_handoff")

    def test_captcha_inside_active_queue_wins_over_queue_marker(self):
        result = self.state("You are in the buying queue. Verify you are human")
        self.assertEqual(result["state"], "captcha_handoff")

    def test_captcha_after_queue_transition_wins_over_challenge_http_status(self):
        for status in (403, 429, 503):
            with self.subTest(status=status):
                result = self.state("hCaptcha security check", status=status)
                self.assertEqual(result["state"], "captcha_handoff")

    def test_otp_handoff(self):
        self.assertEqual(self.state("OTP รหัสยืนยัน")["state"], "otp_handoff")

    def test_reserved_selection(self):
        self.assertEqual(self.state("Seat map เลือกที่นั่ง", seat_controls=12)["state"], "ticket_selection")

    def test_fixed_page_is_reserved_selection_even_without_standard_seat_attributes(self):
        result = self.state("ขั้นตอนที่ 2/4 เลือกที่นั่ง ยืนยันที่นั่ง", url="https://booking.test/fixed.php?zone=A3")
        self.assertEqual(result["state"], "ticket_selection")

    def test_instructional_seat_text_is_not_a_selection_page(self):
        self.assertNotEqual(self.state("อ่านข้อมูลผังที่นั่งและวิธีเลือกที่นั่ง จำนวนบัตร")["state"], "ticket_selection")

    def test_general_admission_selection(self):
        self.assertEqual(self.state("ขั้นตอนที่ 2/4 เลือกจำนวนบัตร General Admission", url="https://tickets.test/festival.php")["state"], "quantity_selection")

    def test_festival_url_wins_over_generic_select_seat_heading(self):
        self.assertEqual(self.state("ขั้นตอนที่ 2/4 เลือกที่นั่ง", url="https://tickets.test/festival.php?k=fixture")["state"], "quantity_selection")

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

    def test_explicit_ticket_status_sold_out_is_terminal(self):
        checkpoint = self.state("Ticket Status SOLD OUT")
        self.assertEqual(checkpoint["state"], "sold_out")
        self.assertEqual(next_action(checkpoint), "stop_and_report_sold_out")

    def test_marketing_sentence_does_not_fake_sold_out_status(self):
        checkpoint = self.state("The artist sold out many shows last year")
        self.assertNotEqual(checkpoint["state"], "sold_out")

    def test_adjacent_seats_require_consecutive_numbers(self):
        seats = [
            {"zone": "A", "row": "R1", "number": "1"},
            {"zone": "A", "row": "R1", "number": "2"},
            {"zone": "A", "row": "R1", "number": "4"},
        ]
        self.assertEqual(choose_seat_indices(seats, 2, "adjacent", ["A"]), [0, 1])
        self.assertEqual(choose_seat_indices(seats, 3, "adjacent", ["A"]), [])

    def test_zone_range_expands_in_user_order(self):
        self.assertEqual(expand_zone_preferences(["A-K"]), list("ABCDEFGHIJK"))
        self.assertEqual(expand_zone_preferences(["C-A"]), ["C", "B", "A"])

    def test_complete_set_is_required_before_any_index_is_returned(self):
        seats = [{"zone": "A", "row": "K", "number": "10", "available": True}]
        self.assertEqual(choose_seat_indices(seats, 2, "same_zone", ["A"]), [])

    def test_rejected_inventory_member_is_not_planned(self):
        seats = [
            {"zone": "A", "row": "K", "number": "10", "available": True},
            {"zone": "A", "row": "K", "number": "11", "available": False},
            {"zone": "A", "row": "K", "number": "12", "available": True},
        ]
        self.assertEqual(choose_seat_indices(seats, 2, "adjacent", ["A"]), [])

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
export PLAYWRIGHT_BROWSERS_PATH="${ALPHA_PLAYWRIGHT_BROWSERS_PATH:-/Volumes/petong/Disk/AI/models/playwright-browsers}"
RUNTIME_VENV="${ALPHA_TICKET_RUNTIME_VENV:-/Volumes/petong/Disk/AI/work/ticket-runtime-venv}"
if [[ ! -x "$RUNTIME_VENV/bin/python" ]]; then "$PYTHON_BIN" -m venv "$RUNTIME_VENV"; fi
if ! "$RUNTIME_VENV/bin/python" -c 'import playwright' >/dev/null 2>&1; then
  "$RUNTIME_VENV/bin/python" -m pip install --disable-pip-version-check -r requirements.txt
fi
exec "$RUNTIME_VENV/bin/python" bot.py "$@"
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

## Visual Seat Recovery + AI Runtime Advisor (beta.28)

- The runtime plans a complete seat set before clicking any seat.
- A rejected or partial set is released, rescanned, and retried in the same allowed zone before moving to the next zone in `seatRecovery.zoneOrder`.
- `maxAttempts: 0` means retry until an explicit terminal server state or user Stop. `A-K` zone ranges are expanded in the exact requested order.
- No blocking local-model call, screenshot, or fixed delay is inserted between seat clicks and checkout. Fast Seat Engine remains deterministic on the critical path.
- Local AI analyzes every runtime state in a background worker. When normal recovery fails it selects and executes a validated action without changing the locked event, schedule, quantity, allowed zones, or payment method.
- A recovery followed by a verified state transition is saved to the shared `work/ticket-ai-recovery-strategies.json` and supplied to later bots and analyses. CAPTCHA, OTP, and actual payment remain explicit human handoffs.
- A run is Full Loop only when both `reservation_verified` and `PAYMENT_HANDOFF` are present in runtime evidence. The browser stays open at QR and never submits payment.

Fixture verification does not mean a live queue or checkout was observed. `CHECKOUT_READY` is never emitted without payment-page evidence.

Public inspection does not require Login. A real run must verify either an existing member session or a successful Login-form transition before Checkout. Set `TICKET_USERNAME` and `TICKET_PASSWORD` in the Terminal session or enter them at the secure prompt; the password is never written to config, reports, or memory.

`preferredZones` may be empty when the zone map is not public yet. At runtime the bot reads A/A1/A2-style zones from the authenticated page and automatically chooses the first currently available zone in the site's own ordering. The selection and discovered alternatives are written to `run-report.jsonl`. `preferredRows`, `preferredSeatNumbers`, and `seatFallbackMode` override that fallback and control exact/nearest selection while keeping all tickets in the chosen zone.

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
        "generator_version": "2.0.0-alpha.1",
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

# alpha-beta23-visible-runtime-evidence-v1
