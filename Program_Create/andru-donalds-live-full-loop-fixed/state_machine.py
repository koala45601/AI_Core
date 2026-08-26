import re
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
    # A visible human challenge wins over HTTP/queue markers. Queue providers
    # commonly serve CAPTCHA with 403/429/503 while preserving the same session.
    if re.search(r"captcha|recaptcha|hcaptcha|ยืนยันว่า.*มนุษย์|verify\s+you\s+are\s+human|security\s+check", text):
        state, evidence = "captcha_handoff", ["captcha marker"]
    elif re.search(r"otp|one[ -]?time|รหัสยืนยัน", text):
        state, evidence = "otp_handoff", ["otp marker"]
    elif http_status in {429, 500, 502, 503, 504}:
        state, evidence = "server_unavailable", [f"http status {http_status}"]
    elif http_status in {401, 403} or re.search(r"access denied|you don'?t have permission to access|การเข้าถึงถูกปฏิเสธ", text):
        state, evidence = "access_denied", [f"server denied browser access ({http_status or 'page marker'})"]
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
    elif "fixed.php" in url or re.search(r"ขั้นตอนที่\s*2/4[\s\S]{0,120}เลือกที่นั่ง", body):
        state, evidence = "ticket_selection", ["reserved seat map page"]
    elif "festival.php" in url or re.search(r"เลือกจำนวนบัตร|ขั้นตอนที่\s*2/4", body):
        state, evidence = "quantity_selection", ["ticket quantity page"]
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
        "access_denied": "show_server_denial_and_wait_for_user",
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
