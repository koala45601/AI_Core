import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
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
show_dates = facts.get("show_dates") if isinstance(facts.get("show_dates"), list) else []
first_show = show_dates[0] if show_dates and isinstance(show_dates[0], dict) else {}
schedule = str(payload.get("schedule") or first_show.get("iso") or first_show.get("raw") or "").strip()
sale_open_at = str(payload.get("sale_open_at") or facts.get("sale_open_at") or "").strip()
queue_open_at = str(payload.get("queue_open_at") or "").strip()
seat_mode = str(payload.get("seat_mode", "")).casefold()
seat_grouping = str(payload.get("seat_grouping", "adjacent")).casefold()
zones = [str(item).strip().upper() for item in payload.get("preferred_zones", []) if str(item).strip()] if isinstance(payload.get("preferred_zones"), list) else []
quantity = max(0, int(payload.get("quantity", 0) or 0))
budget = max(0.0, float(payload.get("budget", 0) or 0))
customer_name = str(payload.get("customer_name", "")).strip()
shipping_address = payload.get("shipping_address") if isinstance(payload.get("shipping_address"), dict) else {}
payment_method = str(payload.get("payment_method", "")).casefold()

missing = []
if not event_url:
    missing.append("event_url")
if not selected or not event_name:
    missing.append("selected_event")
if not schedule or re.search(r"ตาม(?:รอบ|วัน|เวลา|เว็บไซต์)|เลือกในเว็บไซต์|tbd|unknown", schedule, re.I):
    missing.append("schedule")
if not sale_open_at:
    missing.append("sale_open_at")
if not preflight.get("public_page_verified"):
    missing.append("verified_event_facts")
if quantity < 1:
    missing.append("quantity")
if seat_mode not in {"reserved", "standing", "general_admission"}:
    missing.append("seat_mode")
if seat_mode == "reserved" and not zones:
    missing.append("preferred_zones")
if seat_mode == "reserved" and seat_grouping not in {"adjacent", "same_zone", "any"}:
    missing.append("seat_grouping")
if not customer_name:
    missing.append("customer_name")
if not shipping_address:
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
    (project / "tests").mkdir(parents=True)

    selectors = payload.get("selectors") if isinstance(payload.get("selectors"), dict) else {}
    config = {
        "eventId": selected_id,
        "eventName": event_name,
        "eventUrl": event_url,
        "schedule": schedule,
        "saleOpenAt": sale_open_at,
        "queueOpenAt": queue_open_at,
        "saleStatus": str(facts.get("sale_status", "unknown")),
        "quantity": quantity,
        "seatMode": seat_mode,
        "seatGrouping": seat_grouping,
        "preferredZones": zones,
        "budget": budget,
        "customerName": customer_name,
        "shippingAddress": shipping_address,
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
        "handoffPoints": ["login", "captcha", "otp", "payment"],
        "resumeAfterHandoff": True,
    }

    state_machine = r'''import re
from datetime import datetime
from email.utils import parsedate_to_datetime


def _text(snapshot):
    return f"{snapshot.get('url', '')} {snapshot.get('title', '')} {snapshot.get('body', '')}".casefold()


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
    if http_status in {429, 500, 502, 503, 504}:
        state, evidence = "server_unavailable", [f"http status {http_status}"]
    elif re.search(r"captcha|recaptcha|hcaptcha|ยืนยันว่า.*มนุษย์", text):
        state, evidence = "captcha_handoff", ["captcha marker"]
    elif re.search(r"otp|one[ -]?time|รหัสยืนยัน", text):
        state, evidence = "otp_handoff", ["otp marker"]
    elif re.search(r"login|sign in|เข้าสู่ระบบ|รหัสผ่าน", text):
        state, evidence = "login_handoff", ["login marker"]
    elif re.search(r"entry zone|join waiting room|join (?:the )?queue|เข้าห้องรอ|กดรับคิว|รับคิว", text):
        state, evidence = "waiting_room_entry", ["waiting-room entry control"]
    elif re.search(r"buying queue|you are (?:now )?in (?:the )?queue|place in line|status last updated|waiting room|อยู่ในคิว|กำลังเข้าคิว|คิวรอซื้อ", text):
        state, evidence = "queue", ["active queue marker"]
    elif re.search(r"promptpay|พร้อมเพย์|qr code|payment method|ชำระเงิน", text):
        state, evidence = "payment_handoff", ["payment marker"]
    elif re.search(r"select seat|seat map|available seat|เลือกที่นั่ง|เลือกโซน|จำนวนบัตร", text):
        state, evidence = "ticket_selection", ["ticket-selection marker"]
    elif re.search(r"buy now|book now|purchase|checkout|ซื้อบัตร|จองบัตร", text):
        state, evidence = "sale_entry", ["purchase-entry marker"]
    elif re.search(r"coming soon|เตรียมเปิดขาย|กำลังจะเปิด|เร็ว\s*ๆ\s*นี้", text) or (remaining_seconds is not None and remaining_seconds > 0):
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
    }


def verified_payment_handoff(checkpoint):
    return checkpoint.get("state") == "payment_handoff" and bool(checkpoint.get("evidence"))


def next_action(checkpoint):
    state = checkpoint.get("state")
    return {
        "pre_sale": "wait_for_queue_or_sale_window",
        "armed_pre_sale": "hold_same_session_and_count_down",
        "waiting_room_entry": "join_waiting_room_once",
        "sale_entry": "activate_verified_purchase_control",
        "queue": "keep_same_session_and_wait_retry_after",
        "server_unavailable": "keep_same_session_and_wait_retry_after",
        "login_handoff": "user_handoff",
        "captcha_handoff": "user_handoff",
        "otp_handoff": "user_handoff",
        "ticket_selection": "apply_ticket_preferences",
        "payment_handoff": "user_handoff",
    }.get(state, "stop_and_request_new_evidence")


def choose_seat_indices(seats, quantity, grouping="adjacent", preferred_zones=None):
    wanted = max(1, int(quantity))
    zones = [str(item) for item in (preferred_zones or [])]
    available = []
    for index, seat in enumerate(seats):
        if not isinstance(seat, dict) or seat.get("available", True) is False:
            continue
        zone = str(seat.get("zone", ""))
        zone_rank = zones.index(zone) if zone in zones else len(zones)
        available.append({**seat, "_index": index, "_zone_rank": zone_rank})
    available.sort(key=lambda item: (item["_zone_rank"], str(item.get("zone", "")), str(item.get("row", "")), int(item.get("number", 10**9)) if str(item.get("number", "")).isdigit() else 10**9, item["_index"]))
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
import json
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


def record(kind, payload):
    item = {"at": datetime.now().astimezone().isoformat(), "kind": kind, **payload}
    with REPORT.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(item, ensure_ascii=False) + "\n")
    print(json.dumps(item, ensure_ascii=False), flush=True)


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


def apply_ticket_preferences(page):
    wanted = max(1, int(CONFIG.get("quantity", 1)))
    zones = [str(item) for item in CONFIG.get("preferredZones", []) if str(item)]
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
        selected_indices = choose_seat_indices(metadata, wanted, grouping, zones)
        for index in selected_indices:
            seats.nth(index).click()
        selected = len(selected_indices)
        record("selection", {"mode": "reserved", "grouping": grouping, "wanted": wanted, "selected": selected, "indices": selected_indices, "complete": selected == wanted})
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


def run_live(inspect_only=False, wait_for_window=False):
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
        workflow_steps = 0
        while True:
            checkpoint = classify_snapshot(snapshot(page, observed["retry_after"], observed["http_status"], observed["server_date"]), sale_open_at=CONFIG.get("saleOpenAt", ""))
            record("checkpoint", {**checkpoint, "next_action": next_action(checkpoint), "live": True})
            state = checkpoint["state"]
            if state not in {"queue", "server_unavailable"}:
                workflow_steps += 1
                if workflow_steps > 30:
                    record("result", {"status": "WORKFLOW_TRANSITION_LIMIT", "live_checkout_verified": False})
                    break
            if state == "waiting_room_entry":
                if not semantic_click(page, ["Join waiting room", "Join the queue", "Join queue", "เข้าห้องรอ", "กดรับคิว", "รับคิว"]):
                    record("result", {"status": "WAITING_ROOM_CONTROL_NOT_VERIFIED", "live_queue_observed": False, "live_checkout_verified": False})
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
            if state in {"login_handoff", "captcha_handoff", "otp_handoff"}:
                record("handoff", {"status": state.upper(), "resume_supported": True, "same_session": True})
                input("รับช่วงในหน้าต่าง Chrome เฉพาะขั้นนี้ แล้วกลับมากด Enter; บอทจะทำงานต่อด้วย session เดิม: ")
                page.wait_for_timeout(500)
                continue
            if state == "ticket_selection":
                if not apply_ticket_preferences(page):
                    record("result", {"status": "TICKET_QUANTITY_NOT_COMPLETE", "wanted": CONFIG.get("quantity"), "live_checkout_verified": False})
                    input("เลือกบัตรให้ครบใน Chrome แล้วกลับมากด Enter เพื่อให้บอททำต่อ: ")
                    continue
                if not semantic_click(page, ["ดำเนินการต่อ", "ถัดไป", "continue", "next", "ยืนยัน"]):
                    record("result", {"status": "CONTINUE_CONTROL_NOT_VERIFIED", "live_checkout_verified": False})
                    input("ตรวจรายการและกดดำเนินการต่อใน Chrome แล้วกลับมากด Enter: ")
                page.wait_for_timeout(1000)
                continue
            if state == "payment_handoff":
                record("result", {"status": "PAYMENT_HANDOFF", "live_checkout_verified": verified_payment_handoff(checkpoint), "payment_not_submitted": True})
                input("ถึงหน้าชำระเงินจริงแล้ว ระบบหยุดก่อนจ่าย กด Enter เมื่อพี่ตรวจเสร็จ: ")
                context.close()
                return 0
            break
        record("result", {"status": "STOPPED_WITHOUT_VERIFIED_PAYMENT_HANDOFF", "state": checkpoint["state"], "live_checkout_verified": False})
        input("หลักฐานยังไม่พอ ระบบหยุดไว้ให้ตรวจใน Chrome กด Enter เพื่อปิด: ")
        context.close()
        return 3


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--inspect-only", action="store_true")
    parser.add_argument("--wait-for-window", action="store_true")
    args = parser.parse_args()
    if args.dry_run:
        raise SystemExit(verify_fixtures())
    raise SystemExit(run_live(args.inspect_only, args.wait_for_window))


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
    def state(self, body, url="https://tickets.test/event", retry=None, status=None):
        return classify_snapshot({"body": body, "url": url, "title": "Fixture", "retry_after_seconds": retry, "http_status": status})

    def test_pre_sale(self):
        self.assertEqual(self.state("COMING SOON เปิดขายเร็ว ๆ นี้")["state"], "pre_sale")

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
        self.assertEqual(self.state("Buy Now ซื้อบัตร")["state"], "sale_entry")

    def test_queue_preserves_retry_after(self):
        result = self.state("You are in the buying queue. Status last updated", retry=17)
        self.assertEqual(result["state"], "queue")
        self.assertEqual(result["retry_after_seconds"], 17)
        self.assertEqual(next_action(result), "keep_same_session_and_wait_retry_after")

    def test_waiting_room_entry_is_not_active_queue(self):
        result = self.state("YOU ARE NOW IN THE ENTRY ZONE Join waiting room")
        self.assertEqual(result["state"], "waiting_room_entry")
        self.assertEqual(next_action(result), "join_waiting_room_once")

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

    def test_login_handoff(self):
        self.assertEqual(self.state("Login รหัสผ่าน")["state"], "login_handoff")

    def test_captcha_handoff(self):
        self.assertEqual(self.state("reCAPTCHA")["state"], "captcha_handoff")

    def test_otp_handoff(self):
        self.assertEqual(self.state("OTP รหัสยืนยัน")["state"], "otp_handoff")

    def test_reserved_selection(self):
        self.assertEqual(self.state("Seat map เลือกที่นั่ง")["state"], "ticket_selection")

    def test_general_admission_selection(self):
        self.assertEqual(self.state("จำนวนบัตร General Admission")["state"], "ticket_selection")

    def test_multiple_ticket_selection_state(self):
        checkpoint = self.state("Seat map เลือกที่นั่ง จำนวนบัตร 4")
        self.assertEqual(checkpoint["state"], "ticket_selection")

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

    def test_payment_is_verified_only_with_evidence(self):
        checkpoint = self.state("PromptPay QR Code ชำระเงิน", url="https://tickets.test/payment")
        self.assertEqual(checkpoint["state"], "payment_handoff")
        self.assertTrue(verified_payment_handoff(checkpoint))

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
    readme = f'''# {project.name}

Evidence-backed Python + Playwright ticket assistant for **{event_name}**.

## Verification levels

- `verification-report.json`: local state-machine fixture results.
- `python3 bot.py --inspect-only`: read the live public page and write evidence without entering a purchase.
- `python3 bot.py --wait-for-window`: keep one Chrome session, enter the normal queue window, respect Retry-After, and stop for Login/CAPTCHA/OTP/payment.

Fixture verification does not mean a live queue or checkout was observed. `CHECKOUT_READY` is never emitted without payment-page evidence.

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
        "README.md": readme,
    }
    for relative, content in files.items():
        target = project / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    (project / "start.command").chmod(0o755)
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
        "scope": "local deterministic fixtures plus public event-page facts; no live purchase, queue, login or payment was attempted",
    }
    (project / "verification-report.json").write_text(json.dumps(verification, ensure_ascii=False, indent=2), encoding="utf-8")
    result.update({
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
