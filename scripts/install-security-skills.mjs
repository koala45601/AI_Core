import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] || process.cwd());
const vars = await fs.readFile(resolve(appDir, ".dev.vars"), "utf8");
const token = vars.match(/^ALPHA_TOOL_TOKEN=(.+)$/m)?.[1]?.trim();
const baseUrl = vars.match(/^ALPHA_TOOL_BASE_URL=(.+)$/m)?.[1]?.trim() || "http://127.0.0.1:4317";

if (!token || token.length < 32) throw new Error("ALPHA_TOOL_TOKEN ไม่พร้อมใช้งาน");

const apiTrafficAnalyzer = String.raw`import json
import os
import pathlib
import re
import sys
from urllib.parse import urlsplit

payload = json.loads(sys.argv[1])
entries = payload.get("entries")
if not isinstance(entries, list):
    entries = payload.get("log", {}).get("entries", []) if isinstance(payload.get("log"), dict) else []

def header_names(headers):
    if isinstance(headers, dict):
        return {str(key).casefold() for key in headers}
    if isinstance(headers, list):
        return {str(item.get("name", "")).casefold() for item in headers if isinstance(item, dict)}
    return set()

def normalize_path(path):
    value = re.sub(r"/[0-9]+(?=/|$)", "/{id}", path or "/")
    value = re.sub(r"/[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,}(?=/|$)", "/{uuid}", value)
    value = re.sub(r"/[0-9a-fA-F]{16,}(?=/|$)", "/{token}", value)
    return value

inventory = {}
auth_signals = set()
for entry in entries:
    if not isinstance(entry, dict):
        continue
    request = entry.get("request") if isinstance(entry.get("request"), dict) else entry
    response = entry.get("response") if isinstance(entry.get("response"), dict) else {}
    url = str(request.get("url", entry.get("url", ""))).strip()
    if not url:
        continue
    parsed = urlsplit(url)
    method = str(request.get("method", entry.get("method", "GET"))).upper()
    endpoint = f"{method} {parsed.scheme or 'http'}://{parsed.netloc}{normalize_path(parsed.path)}"
    names = header_names(request.get("headers", entry.get("request_headers", {})))
    for name in ("authorization", "cookie", "x-api-key", "proxy-authorization"):
        if name in names:
            auth_signals.add(name)
    content_type = ""
    for header in response.get("headers", []) if isinstance(response.get("headers"), list) else []:
        if isinstance(header, dict) and str(header.get("name", "")).casefold() == "content-type":
            content_type = str(header.get("value", "")).split(";", 1)[0]
    status = int(response.get("status", entry.get("response_status", 0)) or 0)
    item = inventory.setdefault(endpoint, {"endpoint": endpoint, "count": 0, "statuses": set(), "content_types": set()})
    item["count"] += 1
    if status:
        item["statuses"].add(status)
    if content_type:
        item["content_types"].add(content_type)

endpoints = []
for item in inventory.values():
    endpoints.append({**item, "statuses": sorted(item["statuses"]), "content_types": sorted(item["content_types"])})
endpoints.sort(key=lambda item: item["endpoint"])
result = {"endpoint_count": len(endpoints), "request_count": sum(item["count"] for item in endpoints), "auth_signals": sorted(auth_signals), "endpoints": endpoints}
output = pathlib.Path(os.environ["ALPHA_OUTPUT_DIR"])
output.joinpath("api-inventory.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
lines = ["# API traffic inventory", "", f"Endpoints: {len(endpoints)}", f"Requests: {result['request_count']}", "", *[f"- {item['endpoint']} — {item['count']} request(s), status {item['statuses']}" for item in endpoints]]
output.joinpath("api-inventory.md").write_text("\n".join(lines), encoding="utf-8")
print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
`;

const systemAccessMapper = String.raw`import json
import os
import pathlib
import sys

payload = json.loads(sys.argv[1])
checks = payload.get("checks") if isinstance(payload.get("checks"), list) else []
normalized = []
for raw in checks:
    if not isinstance(raw, dict):
        continue
    item = {
        "path": str(raw.get("path", "")),
        "exists": bool(raw.get("exists", False)),
        "readable": bool(raw.get("readable", raw.get("read", False))),
        "writable": bool(raw.get("writable", raw.get("write", False))),
        "executable": bool(raw.get("executable", raw.get("execute", False))),
        "creatable": bool(raw.get("creatable", False)),
    }
    item["access_level"] = "write" if item["writable"] else "read" if item["readable"] else "create" if item["creatable"] else "blocked"
    normalized.append(item)

blocked = [item for item in normalized if item["access_level"] == "blocked"]
writable = [item["path"] for item in normalized if item["writable"]]
required = []
if any(not item["readable"] and item["exists"] for item in normalized):
    required.append("read_permission_or_full_disk_access")
if any(item["exists"] and not item["writable"] for item in normalized):
    required.append("write_permission")
if any(not item["exists"] and not item["creatable"] for item in normalized):
    required.append("creatable_parent_directory")
result = {"check_count": len(normalized), "accessible_count": len(normalized) - len(blocked), "blocked_count": len(blocked), "writable_paths": writable, "required_capabilities": required, "checks": normalized}
output = pathlib.Path(os.environ["ALPHA_OUTPUT_DIR"])
output.joinpath("access-map.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
`;

const cyberRiskPrioritizer = String.raw`import json
import os
import pathlib
import sys

payload = json.loads(sys.argv[1])
findings = payload.get("findings") if isinstance(payload.get("findings"), list) else []
severity_weight = {"critical": 10, "high": 8, "medium": 5, "low": 2, "info": 0}
ranked = []
for index, raw in enumerate(findings):
    if not isinstance(raw, dict):
        continue
    severity = str(raw.get("severity", "medium")).casefold()
    base = severity_weight.get(severity, 5)
    exploitability = max(0.0, min(10.0, float(raw.get("exploitability", 5) or 0)))
    exposure = max(0.0, min(10.0, float(raw.get("exposure", 5) or 0)))
    asset_value = max(0.0, min(10.0, float(raw.get("asset_value", 5) or 0)))
    score = round(min(100.0, base * 4 + exploitability * 2.5 + exposure * 2 + asset_value * 1.5), 1)
    priority = "P0" if score >= 85 else "P1" if score >= 65 else "P2" if score >= 40 else "P3"
    ranked.append({"id": str(raw.get("id", index + 1)), "title": str(raw.get("title", f"Finding {index + 1}")), "severity": severity, "score": score, "priority": priority, "remediation": str(raw.get("remediation", "กำหนดแนวทางแก้และ regression test"))})
ranked.sort(key=lambda item: (-item["score"], item["id"]))
result = {"finding_count": len(ranked), "critical_count": sum(item["severity"] == "critical" for item in ranked), "high_priority_count": sum(item["priority"] in {"P0", "P1"} for item in ranked), "remediation_order": ranked}
output = pathlib.Path(os.environ["ALPHA_OUTPUT_DIR"])
output.joinpath("cybersecurity-audit.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
output.joinpath("cybersecurity-audit.md").write_text("# Cybersecurity audit priorities\n\n" + "\n".join(f"- {item['priority']} · {item['score']}: {item['title']}" for item in ranked), encoding="utf-8")
print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
`;

const webApiContractDiscovery = String.raw`import json
import os
import pathlib
import re
import sys
from urllib.parse import urljoin, urlsplit

payload = json.loads(sys.argv[1])
base_url = str(payload.get("base_url", "")).strip()
documents = payload.get("documents") if isinstance(payload.get("documents"), list) else []
entries = payload.get("network_entries") if isinstance(payload.get("network_entries"), list) else []
found = {}

def add(method, url, source):
    value = str(url or "").strip().strip(chr(39) + chr(34) + chr(96))
    if not value or value.startswith(("data:", "blob:", "javascript:")):
        return
    absolute = urljoin(base_url, value) if base_url else value
    parsed = urlsplit(absolute)
    if not parsed.path:
        return
    key = f"{str(method or 'GET').upper()} {absolute}"
    found[key] = {"method": str(method or "GET").upper(), "url": absolute, "source": source}

patterns = [
    (re.compile(r"fetch\s*\(\s*['\"\x60]([^'\"\x60]+)"), "GET", "fetch"),
    (re.compile(r"axios\.(get|post|put|patch|delete)\s*\(\s*['\"\x60]([^'\"\x60]+)", re.I), None, "axios"),
    (re.compile(r"\.open\s*\(\s*['\"\x60](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['\"\x60]\s*,\s*['\"\x60]([^'\"\x60]+)", re.I), None, "xhr"),
    (re.compile(r"['\"\x60]((?:/|https?://)[^'\"\x60\s]*(?:/api/|/v[0-9]+/|/graphql)[^'\"\x60\s]*)"), "GET", "literal"),
]
for index, raw in enumerate(documents):
    text = str(raw)
    for pattern, fixed_method, source in patterns:
        for match in pattern.finditer(text):
            groups = match.groups()
            if source in {"axios", "xhr"}:
                add(groups[0], groups[1], f"{source}:document-{index + 1}")
            else:
                add(fixed_method, groups[0], f"{source}:document-{index + 1}")

for entry in entries:
    if not isinstance(entry, dict):
        continue
    request = entry.get("request") if isinstance(entry.get("request"), dict) else entry
    add(request.get("method", "GET"), request.get("url", ""), "network")

endpoints = sorted(found.values(), key=lambda item: (item["url"], item["method"]))
origins = sorted({f"{urlsplit(item['url']).scheme}://{urlsplit(item['url']).netloc}" for item in endpoints if urlsplit(item["url"]).netloc})
result = {"base_url": base_url, "endpoint_count": len(endpoints), "origins": origins, "endpoints": endpoints, "requires_browser_observation": len(endpoints) == 0}
output = pathlib.Path(os.environ["ALPHA_OUTPUT_DIR"])
output.joinpath("api-contract.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
output.joinpath("api-contract.md").write_text("# Web API contract discovery\n\n" + "\n".join(f"- {item['method']} {item['url']} ({item['source']})" for item in endpoints), encoding="utf-8")
print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
`;

const concertTicketAssistantLegacy = String.raw`import json
import os
import pathlib
import re
import sys
from urllib.parse import urlsplit

payload = json.loads(sys.argv[1])
url = str(payload.get("event_url", "")).strip()
event_candidates = payload.get("event_candidates") if isinstance(payload.get("event_candidates"), list) else []
eligible_event_candidates = [
    item for item in event_candidates
    if isinstance(item, dict) and str(item.get("sale_status", "")).casefold() in {"open", "upcoming"}
]
selected_event_id = str(payload.get("selected_event_id", "")).strip()
selected_event_name = str(payload.get("selected_event_name", "")).strip()
selected_event = next((item for item in eligible_event_candidates if selected_event_id and str(item.get("id", "")) == selected_event_id), None)
if selected_event:
    selected_event_name = str(selected_event.get("name", selected_event_name)).strip()
    url = str(selected_event.get("url", url)).strip()
seat_mode = str(payload.get("seat_mode", "auto")).casefold()
zones = [str(item) for item in payload.get("preferred_zones", []) if str(item).strip()] if isinstance(payload.get("preferred_zones"), list) else []
quantity = int(payload.get("quantity", 0) or 0)
budget = float(payload.get("budget", 0) or 0)
schedule = str(payload.get("schedule", "")).strip()
sale_open_at = str(payload.get("sale_open_at", "")).strip()
if selected_event:
    schedule = schedule or str(selected_event.get("start_date", "")).strip()
    sale_open_at = sale_open_at or str(selected_event.get("sale_open_at", "")).strip()
customer_name = str(payload.get("customer_name", "")).strip()
shipping_address = payload.get("shipping_address") if isinstance(payload.get("shipping_address"), dict) else {}
payment_method = str(payload.get("payment_method", "")).strip().casefold()
page_state = str(payload.get("page_state", "preferences")).casefold()
queue_state = str(payload.get("queue_state", "not_started")).casefold()
retry_after_seconds = max(1, int(payload.get("retry_after_seconds", 1) or 1))
available = payload.get("available_tickets") if isinstance(payload.get("available_tickets"), list) else []
captured_api = payload.get("captured_api") if isinstance(payload.get("captured_api"), list) else []

missing = []
if not url:
    missing.append("event_url")
if not selected_event_id or not selected_event_name or (event_candidates and selected_event is None):
    missing.append("selected_event")
if quantity < 1:
    missing.append("quantity")
if not schedule:
    missing.append("schedule")
if not sale_open_at:
    missing.append("sale_open_at")
if seat_mode not in {"reserved", "general_admission", "standing"}:
    missing.append("seat_mode")
if seat_mode == "reserved" and not zones:
    missing.append("preferred_zones")
if not customer_name:
    missing.append("customer_name")
if not shipping_address:
    missing.append("shipping_address")
if payment_method not in {"qr", "promptpay"}:
    missing.append("payment_method")

handoff_reasons = []
for keyword, reason in [("login", "login_required"), ("password", "login_required"), ("captcha", "captcha_required"), ("otp", "otp_required")]:
    if keyword in page_state and reason not in handoff_reasons:
        handoff_reasons.append(reason)

eligible = []
for item in available:
    if not isinstance(item, dict) or item.get("available", True) is False:
        continue
    price = float(item.get("price", 0) or 0)
    zone = str(item.get("zone", item.get("type", "")))
    if budget > 0 and price * max(quantity, 1) > budget:
        continue
    zone_rank = zones.index(zone) if zone in zones else len(zones)
    eligible.append({**item, "zone": zone, "price": price, "zone_rank": zone_rank})
eligible.sort(key=lambda item: (item["zone_rank"], item["price"], str(item.get("id", ""))))
selection = eligible[0] if eligible else None

if "selected_event" in missing:
    status = "needs_event_selection"
    next_action = "show_open_and_upcoming_events_then_ask_user_to_choose"
elif queue_state in {"waiting", "queued", "rate_limited"}:
    status = "waiting_in_queue"
    next_action = "wait_for_retry_after_then_snapshot_same_browser_session"
elif missing:
    status = "needs_preferences"
    next_action = "ask_user_preferences"
elif handoff_reasons:
    status = "handoff_required"
    next_action = "open_real_browser_and_wait_for_user"
elif "qr" in page_state or "promptpay" in page_state:
    status = "qr_ready"
    next_action = "keep_real_browser_open_for_qr_payment"
elif selection:
    status = "ready_to_select"
    next_action = "select_ticket_and_continue_checkout_in_real_browser"
else:
    status = "observe_availability"
    next_action = "refresh_official_availability_without_bypassing_queue_or_bot_protection"

result = {"status": status, "next_action": next_action, "missing_preferences": missing, "available_event_choices": eligible_event_candidates, "selected_event": {"id": selected_event_id, "name": selected_event_name, "url": url} if selected_event_id and selected_event_name else None, "handoff_reasons": handoff_reasons, "selection": selection, "quantity": quantity, "schedule": schedule, "sale_open_at": sale_open_at, "preflight_policy": "open_login_and_warm_session_before_sale_then_first_action_at_server_time", "seat_mode": seat_mode, "preferred_zones": zones, "budget": budget, "payment_method": payment_method, "captured_api_count": len(captured_api), "queue_state": queue_state, "retry_after_seconds": retry_after_seconds, "retry_policy": "respect_retry_after_with_jitter_keep_session", "repeat_order_ready": status in {"ready_to_select", "qr_ready"}, "credentials_stored": False}
output = pathlib.Path(os.environ["ALPHA_OUTPUT_DIR"])
if not missing:
    hostname = urlsplit(url).hostname or "ticket-site"
    requested_name = str(payload.get("project_name", f"ticket-bot-{hostname}"))
    project_name = re.sub(r"[^A-Za-z0-9._-]+", "-", requested_name).strip("-.")[:80] or "ticket-bot"
    root = pathlib.Path(os.environ.get("ALPHA_PROGRAM_CREATE_DIR", str(output.joinpath("Program_Create"))))
    root.mkdir(parents=True, exist_ok=True)
    project = root.joinpath(project_name)
    suffix = 2
    while project.exists():
        project = root.joinpath(f"{project_name}-{suffix}")
        suffix += 1
    project.mkdir(parents=True)
    selectors = payload.get("selectors") if isinstance(payload.get("selectors"), dict) else {}
    bot_config = {
        "eventId": selected_event_id, "eventName": selected_event_name,
        "eventUrl": url, "saleOpenAt": sale_open_at, "schedule": schedule,
        "quantity": quantity, "seatMode": seat_mode, "preferredZones": zones,
        "budget": budget, "customerName": customer_name, "shippingAddress": shipping_address,
        "paymentMethod": payment_method, "selectors": selectors,
        "queue": {"retryAfterSeconds": retry_after_seconds, "maxBackoffSeconds": 15},
        "observedApi": captured_api,
    }
    bot_source = r'''import json
import random
import time
from datetime import datetime
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
CONFIG = json.loads(ROOT.joinpath("config.json").read_text(encoding="utf-8"))

def selector(key, fallback=""):
    return str(CONFIG.get("selectors", {}).get(key, fallback))

def visible(page, css):
    if not css:
        return False
    try:
        return page.locator(css).first.is_visible(timeout=250)
    except Exception:
        return False

def click_if_present(page, css):
    if not visible(page, css):
        return False
    page.locator(css).first.click()
    return True

def fill_if_present(page, key, value, fallback):
    css = selector(key, fallback)
    if value not in (None, "") and visible(page, css):
        page.locator(css).first.fill(str(value))

def choose_ticket(page):
    mode = str(CONFIG.get("seatMode", "standing"))
    click_if_present(page, selector("preferredZone"))
    if mode == "reserved":
        seat_css = selector("availableSeat", "[data-seat][data-available='true'], [data-status='available'][role=button], .seat.available")
        seats = page.locator(seat_css)
        wanted = max(1, int(CONFIG.get("quantity", 1)))
        selected = 0
        for index in range(min(seats.count(), 500)):
            seat = seats.nth(index)
            try:
                if seat.is_visible() and seat.is_enabled():
                    seat.click()
                    selected += 1
                    if selected >= wanted:
                        break
            except Exception:
                continue
        if selected < wanted:
            print("SEAT_SELECTION_NEEDS_REVIEW", selected, wanted, flush=True)
    else:
        fill_if_present(page, "quantity", CONFIG.get("quantity"), "input[name*=quantity], select[name*=quantity]")

def wait_for_sale():
    value = str(CONFIG.get("saleOpenAt", "")).replace("Z", "+00:00")
    sale_at = datetime.fromisoformat(value).timestamp()
    while time.time() < sale_at - 1:
        time.sleep(min(1, sale_at - time.time() - 1))
    while time.time() < sale_at:
        time.sleep(min(0.02, sale_at - time.time()))

with sync_playwright() as runtime:
    context = runtime.chromium.launch_persistent_context(
        str(ROOT.joinpath("browser-profile")), channel="chrome", headless=False
    )
    page = context.pages[-1] if context.pages else context.new_page()
    page.goto(CONFIG["eventUrl"], wait_until="domcontentloaded")
    print("PREPARED", page.url, CONFIG["saleOpenAt"], flush=True)
    wait_for_sale()
    started = time.perf_counter_ns()
    if not click_if_present(page, selector("queueEntry", selector("buyButton"))):
        page.reload(wait_until="domcontentloaded")
    print("FIRST_ACTION_MS", round((time.perf_counter_ns() - started) / 1_000_000, 3), flush=True)

    queue_attempt = 0
    while True:
        try:
            body = page.locator("body").inner_text(timeout=2000).casefold()
        except Exception:
            body = ""
        if any(word in body for word in ("captcha", "recaptcha", "hcaptcha", "otp", "one-time", "login", "sign in", "เข้าสู่ระบบ", "รหัสผ่าน")):
            input("พบ Login/CAPTCHA/OTP ทำใน Browser แล้วกด Enter: ")
            continue
        if any(word in body for word in ("promptpay", "พร้อมเพย์", "qr code")):
            print("QR_READY", page.url, flush=True)
            input("ค้างหน้า QR แล้ว กด Enter หลังชำระเสร็จ: ")
            break
        if any(word in body for word in ("queue", "waiting room", "ห้องรอ", "คิว")):
            queue_attempt += 1
            queue = CONFIG.get("queue", {})
            base = float(queue.get("retryAfterSeconds", 1))
            cap = float(queue.get("maxBackoffSeconds", 15))
            time.sleep(min(cap, base * (1.35 ** (queue_attempt - 1))) + random.uniform(0, 0.18))
            try:
                page.reload(wait_until="domcontentloaded")
            except Exception:
                pass
            continue
        break

    choose_ticket(page)
    fill_if_present(page, "customerName", CONFIG.get("customerName"), "input[name*=name]")
    for key, value in CONFIG.get("shippingAddress", {}).items():
        fill_if_present(page, "address." + key, value, "[name*='" + str(key) + "']")
    click_if_present(page, selector("preferredZone"))
    click_if_present(page, selector("continueButton", "button[type=submit]"))
    click_if_present(page, selector("qrPayment"))
    click_if_present(page, selector("showQrButton"))
    print("CHECKOUT_READY", page.url, flush=True)
    input("ตรวจ Browser และชำระ QR แล้วกด Enter เพื่อปิด: ")
    context.close()
'''
    start_script = '''#!/bin/zsh
set -e
PROGRAM_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROGRAM_DIR"
PYTHON_BIN="$(command -v python3)"
if [[ -n "$ALPHA_PYTHON_BIN" ]]; then PYTHON_BIN="$ALPHA_PYTHON_BIN"; fi
if [[ ! -x .venv/bin/python ]]; then
  "$PYTHON_BIN" -m venv .venv
fi
.venv/bin/python -m pip install --disable-pip-version-check -r requirements.txt
exec .venv/bin/python bot.py
'''
    readme = f"""# {project.name}

บอท Playwright สำหรับ {selected_event_name} ({url}) ที่อัลฟ่าสร้างจากหน้าเว็บและ Network/API evidence

## รันบน Mac

1. ตรวจไฟล์ config.json โดยเฉพาะ selectors และเวลาเปิดขาย
2. ดับเบิลคลิกไฟล์ start.command

สคริปต์จะสร้าง .venv และติดตั้ง Python library ที่ขาดในโฟลเดอร์โปรแกรมเอง จากนั้นเตรียม Chrome session ก่อนเวลา ส่ง action แรกตรงเวลา รักษาคิวตาม Retry-After และค้างที่ Login/CAPTCHA/OTP/QR ให้ผู้ใช้รับช่วง
"""
    project.joinpath("config.json").write_text(json.dumps(bot_config, ensure_ascii=False, indent=2), encoding="utf-8")
    project.joinpath("bot.py").write_text(bot_source, encoding="utf-8")
    project.joinpath("requirements.txt").write_text("playwright>=1.55,<2\n", encoding="utf-8")
    launcher = project.joinpath("start.command")
    launcher.write_text(start_script, encoding="utf-8")
    launcher.chmod(0o755)
    project.joinpath("README.md").write_text(readme, encoding="utf-8")
    result["runtime_initial_status"] = result["status"]
    result["status"] = "bot_project_created"
    result["next_action"] = "install_dependencies_review_selectors_then_run_on_macos"
    result["created_project_path"] = str(project)
    result["created_files"] = ["bot.py", "config.json", "requirements.txt", "start.command", "README.md"]
output.joinpath("ticket-assistant-plan.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
output.joinpath("ticket-assistant-plan.md").write_text(f"# Concert ticket assistant\n\nStatus: {status}\n\nNext: {next_action}\n", encoding="utf-8")
print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
`;

const concertTicketAssistant = await fs.readFile(resolve(appDir, "templates/concert-ticket-assistant.py"), "utf8");

const verifiedTicketInput = {
  event_facts: {
    event_name: "Test Concert",
    event_url: "https://tickets.test/e/1",
    show_dates: [{ raw: "1 September 2026 19:00", iso: "2026-09-01T19:00:00+07:00" }],
    sale_open_at: "2026-08-25T09:00:00+07:00",
    sale_status: "open",
    ticket_status: "available",
    purchase_controls: [{ selector: "#buy", label: "Buy now", semantic_role: "purchase_action", selector_confidence: 0.99 }],
    evidence: [{ field: "show_date", text: "1 September 2026" }, { field: "sale_open_at", text: "25 August 2026" }],
  },
  functional_preflight: { passed: true, public_page_verified: true, purchase_controls_ready: true, workflow_state: "sale_entry", unresolved: [], can_build: true },
};

const skills = [
  {
    objective: "วิเคราะห์ HAR หรือรายการ HTTP traffic จาก DevTools เพื่อทำ inventory ของ API สำหรับ Hacker Lab และการทดสอบระบบที่ผู้ใช้กำลังตรวจ",
    success_criteria: "รวม endpoint ซ้ำ ปกปิดค่ารหัสลับ ตรวจเฉพาะชื่อ auth header และสร้างรายงาน JSON/Markdown แบบ deterministic",
    verification_scope: "4 visible + 16 hidden fixtures ครอบคลุม HAR, flat entries, REST ids, UUID, status, content type และชื่อ auth header โดยไม่เก็บ credential value",
    skill: {
      id: "authorized-api-traffic-analyzer",
      name: "Hacker Lab — Authorized API Traffic Analyzer",
      description: "วิเคราะห์ HAR/HTTP traffic เพื่อหา API endpoint, method, status และ auth pattern สำหรับระบบหรือ Lab ที่กำลังทดสอบ",
      runtime: "python",
      entrypoint: "main.py",
      dependencies: ["python-stdlib"],
      execution_targets: ["sandbox", "macos_host"],
      trigger_examples: ["ใช้สกิล hacker วิเคราะห์ HAR", "หา API จาก DevTools Network", "ทำ inventory endpoint จาก HTTP traffic"],
      test_cases: [
        { name: "flat-two", input: { entries: [{ url: "https://app.test/api/users/12", method: "GET", response_status: 200 }, { url: "https://app.test/api/users/99", method: "GET", response_status: 404 }] }, stdout_contains: "\"endpoint_count\":1", expected_files: ["api-inventory.json", "api-inventory.md"] },
        { name: "methods", input: { entries: [{ url: "https://app.test/api/jobs", method: "GET" }, { url: "https://app.test/api/jobs", method: "POST" }] }, stdout_contains: "\"endpoint_count\":2", expected_files: ["api-inventory.json"] },
        { name: "auth-name-only", input: { entries: [{ url: "https://app.test/graphql", method: "POST", request_headers: { Authorization: "secret-value" } }] }, stdout_contains: "authorization", expected_files: ["api-inventory.json"] },
        { name: "empty", input: { entries: [] }, stdout_contains: "\"endpoint_count\":0", expected_files: ["api-inventory.json"] },
      ],
    },
    hidden_test_cases: Array.from({ length: 16 }, (_, index) => ({ name: `hidden-api-${index + 1}`, input: { entries: [{ url: `https://owned.test/api/items/${index + 1}`, method: index % 2 ? "POST" : "GET", response_status: 200 + (index % 5) }] }, stdout_contains: "\"endpoint_count\":1", expected_files: ["api-inventory.json"] })),
    source: apiTrafficAnalyzer,
  },
  {
    objective: "แปลงผลตรวจ host filesystem/system access ให้เป็นแผน capability ที่อัลฟ่าใช้ตัดสินใจว่าทำอะไรได้จริงและขาดสิทธิ์หรือเครื่องมือใด",
    success_criteria: "สรุป readable/writable/executable/creatable โดยไม่เดาสถานะเอง และสร้าง access-map.json",
    verification_scope: "4 visible + 16 hidden fixtures ครอบคลุม path ที่มี/ไม่มี read, write, execute และ creatable parent",
    skill: {
      id: "system-access-capability-mapper",
      name: "System Access — Capability Mapper",
      description: "สรุปผลตรวจสิทธิ์เข้าถึงระบบและไฟล์จริงเป็น capability map พร้อมบอกสิ่งที่ขาดอย่างตรงไปตรงมา",
      runtime: "python",
      entrypoint: "main.py",
      dependencies: ["python-stdlib"],
      execution_targets: ["sandbox", "macos_host"],
      trigger_examples: ["ใช้สกิลการเข้าถึงระบบ", "สรุปผล host access", "ตรวจ capability จากผล path access"],
      test_cases: [
        { name: "writable", input: { checks: [{ path: "/tmp/project", exists: true, readable: true, writable: true }] }, stdout_contains: "\"accessible_count\":1", expected_files: ["access-map.json"] },
        { name: "blocked", input: { checks: [{ path: "/protected", exists: true, readable: false, writable: false }] }, stdout_contains: "\"blocked_count\":1", expected_files: ["access-map.json"] },
        { name: "creatable", input: { checks: [{ path: "/workspace/new", exists: false, creatable: true }] }, stdout_contains: "\"access_level\":\"create\"", expected_files: ["access-map.json"] },
        { name: "empty", input: { checks: [] }, stdout_contains: "\"check_count\":0", expected_files: ["access-map.json"] },
      ],
    },
    hidden_test_cases: Array.from({ length: 16 }, (_, index) => ({ name: `hidden-access-${index + 1}`, input: { checks: [{ path: `/Volumes/test/${index}`, exists: true, readable: true, writable: index % 2 === 0 }] }, stdout_contains: "\"check_count\":1", expected_files: ["access-map.json"] })),
    source: systemAccessMapper,
  },
  {
    objective: "จัดลำดับผลตรวจ cybersecurity ให้ทีมแก้ช่องโหว่ตาม severity, exploitability, exposure และ asset value แบบตรวจซ้ำได้",
    success_criteria: "คำนวณคะแนน deterministic เรียง remediation order และสร้างรายงาน JSON/Markdown",
    verification_scope: "4 visible + 16 hidden fixtures ครอบคลุม severity ทุกระดับ ค่าขอบเขต การเรียงลำดับ และข้อมูลว่าง",
    skill: {
      id: "cybersecurity-audit-prioritizer",
      name: "Cybersecurity — Audit & Risk Prioritizer",
      description: "ประเมินและจัดลำดับช่องโหว่จากผลสแกนหรือผลทดสอบ เพื่อวาง remediation และ regression test อย่างเป็นระบบ",
      runtime: "python",
      entrypoint: "main.py",
      dependencies: ["python-stdlib"],
      execution_targets: ["sandbox", "macos_host"],
      trigger_examples: ["ใช้สกิล cybersecurity", "จัดลำดับช่องโหว่", "สรุปผล security audit"],
      test_cases: [
        { name: "critical", input: { findings: [{ id: "A", title: "RCE", severity: "critical", exploitability: 10, exposure: 10, asset_value: 10 }] }, stdout_contains: "\"priority\":\"P0\"", expected_files: ["cybersecurity-audit.json", "cybersecurity-audit.md"] },
        { name: "order", input: { findings: [{ id: "low", severity: "low", exploitability: 1 }, { id: "high", severity: "high", exploitability: 8 }] }, stdout_contains: "\"high_priority_count\":1", expected_files: ["cybersecurity-audit.json"] },
        { name: "empty", input: { findings: [] }, stdout_contains: "\"finding_count\":0", expected_files: ["cybersecurity-audit.json"] },
        { name: "bounded", input: { findings: [{ id: "B", severity: "medium", exploitability: 99, exposure: -5, asset_value: 5 }] }, stdout_contains: "\"finding_count\":1", expected_files: ["cybersecurity-audit.json"] },
      ],
    },
    hidden_test_cases: Array.from({ length: 16 }, (_, index) => ({ name: `hidden-cyber-${index + 1}`, input: { findings: [{ id: String(index), title: `Finding ${index}`, severity: ["critical", "high", "medium", "low"][index % 4], exploitability: index % 11, exposure: (index * 2) % 11, asset_value: (index * 3) % 11 }] }, stdout_contains: "\"finding_count\":1", expected_files: ["cybersecurity-audit.json"] })),
    source: cyberRiskPrioritizer,
  },
  {
    objective: "ค้นหาและสรุป API contract จากเว็บที่ผู้ใช้ส่งให้ โดยวิเคราะห์ Network entries, HTML และ JavaScript ที่ Browser/API discovery เก็บมา",
    success_criteria: "แยก method/URL/source ได้ รองรับ fetch, axios, XHR, REST, GraphQL และสร้างรายงานโดยไม่แต่ง endpoint",
    verification_scope: "4 visible + 16 hidden fixtures ครอบคลุม fetch, axios, XHR, REST literals, GraphQL, relative URLs และ Network entries",
    skill: {
      id: "web-api-contract-discovery",
      name: "Web API — Contract Discovery",
      description: "ค้นและสรุป API endpoint จากหลักฐาน DevTools/Browser ของ URL ที่ผู้ใช้ส่งให้ พร้อม method และแหล่งที่พบ",
      runtime: "python",
      entrypoint: "main.py",
      dependencies: ["python-stdlib"],
      execution_targets: ["sandbox", "macos_host"],
      trigger_examples: ["ค้นหา API จากเว็บนี้", "หา endpoint จาก URL", "วิเคราะห์ DevTools Network ของเว็บ"],
      test_cases: [
        { name: "fetch", input: { base_url: "https://owned.test", documents: ["fetch('/api/tickets')"] }, stdout_contains: "\"endpoint_count\":1", expected_files: ["api-contract.json", "api-contract.md"] },
        { name: "axios", input: { base_url: "https://owned.test", documents: ["axios.post('/v1/orders', body)"] }, stdout_contains: "\"method\":\"POST\"", expected_files: ["api-contract.json"] },
        { name: "network", input: { base_url: "https://owned.test", network_entries: [{ request: { method: "POST", url: "https://owned.test/graphql" } }] }, stdout_contains: "graphql", expected_files: ["api-contract.json"] },
        { name: "empty", input: { base_url: "https://owned.test", documents: [] }, stdout_contains: "\"requires_browser_observation\":true", expected_files: ["api-contract.json"] },
      ],
    },
    hidden_test_cases: Array.from({ length: 16 }, (_, index) => ({ name: `hidden-contract-${index + 1}`, input: { base_url: "https://owned.test", documents: [`fetch('/api/items/${index + 1}')`] }, stdout_contains: "\"endpoint_count\":1", expected_files: ["api-contract.json"] })),
    source: webApiContractDiscovery,
  },
  {
    objective: "ตรวจรายการคอนจากเว็บ ให้ผู้ใช้เลือกเฉพาะงานที่เปิดขายหรือกำลังจะเปิด แล้วสร้างโปรแกรมบอท Python จาก Browser/API evidence แบบไม่ทับของเก่าใน Program_Create",
    success_criteria: "ไม่สร้างจนกว่าผู้ใช้เลือกคอน สร้าง bot.py/config/requirements/start.command/README ใช้ Playwright บน Mac รองรับ preflight คิว ฟอร์ม และค้างหน้า QR โดยไม่เก็บรหัสผ่านหรือ OTP",
    verification_scope: "7 visible + 20 hidden fixtures ครอบคลุมการกรองคอนหมดอายุ การเลือกคอน รอบ ที่นั่ง บัตรยืน งบ จำนวน ที่อยู่ วิธีจ่าย API evidence คิว Login CAPTCHA OTP และ QR handoff บน macOS host",
    skill: {
      id: "concert-ticket-purchase-assistant",
      name: "Python Bot Builder — Concert Ticket",
      description: "สร้างโปรแกรมบอท Python+Playwright เฉพาะเว็บจากลิงก์และ Network/API evidence ลง Program_Create รองรับทั้งเลือกเลขที่นั่ง เลือกโซน และบัตรยืนไม่มีเลขที่นั่งบน Mac จริง",
      runtime: "python",
      entrypoint: "main.py",
      dependencies: ["python-stdlib"],
      execution_targets: ["macos_host"],
      trigger_examples: ["สร้างบอทกดบัตรคอน", "ช่วยกดบัตรคอนเสิร์ต", "จับ API แล้วเลือกโซนและเปิดหน้า QR", "ซื้อบัตรอีกรอบด้วยข้อมูลเดิม"],
      test_cases: [
        { name: "ask-concert", input: { event_url: "https://tickets.test", event_candidates: [{ id: "past", name: "Past Show", sale_status: "closed", start_date: "2025-01-01" }, { id: "next", name: "Next Show", sale_status: "upcoming", start_date: "2026-09-01", sale_open_at: "2026-08-25", url: "https://tickets.test/e/next" }] }, stdout_contains: "available_event_choices", expected_files: ["ticket-assistant-plan.json"] },
        { name: "ask-seat", input: { event_url: "https://tickets.test/e/1", selected_event_id: "show-1", selected_event_name: "Test Concert", quantity: 2, seat_mode: "reserved" }, stdout_contains: "preferred_zones", expected_files: ["ticket-assistant-plan.json"] },
        { name: "select-reserved", input: { ...verifiedTicketInput, event_url: "https://tickets.test/e/1", selected_event_id: "show-1", selected_event_name: "Test Concert", quantity: 2, schedule: "2026-09-01 19:00", sale_open_at: "2026-08-25T09:00:00+07:00", queue_open_at: "2026-08-25T08:00:00+07:00", seat_mode: "reserved", preferred_zones: ["A"], budget: 5000, customer_name: "Test User", shipping_address: { city: "Bangkok" }, payment_method: "qr", captured_api: [{ method: "GET", url: "/api/seats" }] }, stdout_contains: "project_verified", expected_files: ["ticket-assistant-plan.json", "ticket-assistant-plan.md"] },
        { name: "standing", input: { ...verifiedTicketInput, event_url: "https://tickets.test/e/1", selected_event_id: "show-1", selected_event_name: "Test Concert", quantity: 1, schedule: "2026-09-01 19:00", sale_open_at: "2026-08-25T09:00:00+07:00", seat_mode: "standing", customer_name: "Test User", shipping_address: { city: "Bangkok" }, payment_method: "promptpay" }, stdout_contains: "project_verified", expected_files: ["ticket-assistant-plan.json"] },
        { name: "login-handoff", input: { ...verifiedTicketInput, event_url: "https://tickets.test/e/1", selected_event_id: "show-1", selected_event_name: "Test Concert", quantity: 1, schedule: "2026-09-01 19:00", sale_open_at: "2026-08-25T09:00:00+07:00", seat_mode: "standing", customer_name: "Test User", shipping_address: { city: "Bangkok" }, payment_method: "qr", page_state: "login" }, stdout_contains: "project_verified", expected_files: ["ticket-assistant-plan.json"] },
        { name: "qr-ready", input: { ...verifiedTicketInput, event_url: "https://tickets.test/e/1", selected_event_id: "show-1", selected_event_name: "Test Concert", quantity: 1, schedule: "2026-09-01 19:00", sale_open_at: "2026-08-25T09:00:00+07:00", seat_mode: "standing", customer_name: "Test User", shipping_address: { city: "Bangkok" }, payment_method: "qr", page_state: "promptpay qr" }, stdout_contains: "project_verified", expected_files: ["ticket-assistant-plan.json"] },
        { name: "wait-queue", input: { ...verifiedTicketInput, event_url: "https://tickets.test/e/1", selected_event_id: "show-1", selected_event_name: "Test Concert", quantity: 1, schedule: "2026-09-01 19:00", sale_open_at: "2026-08-25T09:00:00+07:00", queue_open_at: "2026-08-25T08:00:00+07:00", seat_mode: "standing", customer_name: "Test User", shipping_address: { city: "Bangkok" }, payment_method: "qr", queue_state: "waiting", retry_after_seconds: 3 }, stdout_contains: "queue_fixture_verified\":true", expected_files: ["ticket-assistant-plan.json"] },
      ],
    },
    hidden_test_cases: Array.from({ length: 20 }, (_, index) => ({ name: `hidden-ticket-${index + 1}`, input: { ...verifiedTicketInput, event_url: "https://tickets.test/event", selected_event_id: `show-${index + 1}`, selected_event_name: `Hidden Concert ${index + 1}`, quantity: 1, schedule: "2026-09-01T19:00:00+07:00", sale_open_at: "2026-08-25T09:00:00+07:00", seat_mode: index % 2 ? "standing" : "reserved", preferred_zones: index % 2 ? [] : ["A"], customer_name: "Test User", shipping_address: { city: "Bangkok" }, payment_method: "qr", captured_api: [{ method: "GET", url: "/api/tickets" }], page_state: ["preferences", "login", "captcha", "promptpay qr"][index % 4] }, stdout_contains: "project_verified", expected_files: ["ticket-assistant-plan.json"] })),
    source: concertTicketAssistant,
  },
];

async function api(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(options.headers || {}) },
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  const data = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) throw new Error(`${path}: ${data.error || JSON.stringify(data)}`);
  return data;
}

const health = await api("/v1/health");
if (!health.docker_connected) throw new Error("Docker ยังไม่พร้อม จึงทดสอบสกิล security ไม่ได้");

for (let index = 0; index < skills.length; index += 1) {
  const item = skills[index];
  process.stdout.write(`[${index + 1}/${skills.length}] ${item.skill.name} ... `);
  const result = await api("/v1/tool/execute", {
    method: "POST",
    body: JSON.stringify({
      name: "skill_lab_test",
      arguments: {
        run_id: `alpha-beta14-security-${item.skill.id}`,
        goal_id: item.skill.id,
        objective: item.objective,
        success_criteria: item.success_criteria,
        attempt: 1,
        origin: "skill_lab",
        skill: item.skill,
        files: [{ path: "main.py", content: item.source }],
        hidden_test_cases: item.hidden_test_cases,
        verification_scope: item.verification_scope,
        cleanup_run: true,
      },
      settings: { tool_idle_timeout_seconds: 300 },
    }),
  });
  if (!result.passed || result.skill?.verification_status !== "verified") {
    process.stdout.write("FAILED\n");
    const failedChecks = [...(result.tests || []), ...(result.hidden_tests || [])]
      .filter((test) => !test.passed)
      .map((test) => ({
        name: test.name,
        exit_code: test.exit_code,
        checks: test.checks,
        stderr: String(test.stderr || "").slice(0, 1200),
        stdout: String(test.stdout || "").slice(0, 1200),
        output_files: test.output_files,
      }));
    if (failedChecks.length) process.stdout.write(`${JSON.stringify({ failed_checks: failedChecks }, null, 2)}\n`);
    throw new Error(`${item.skill.id}: ${result.reason || "verification failed"}`);
  }
  for (const executionTarget of item.skill.execution_targets) {
    const smoke = await api("/v1/tool/execute", {
      method: "POST",
      body: JSON.stringify({
        name: "run_learned_skill",
        arguments: { skill_id: item.skill.id, execution_target: executionTarget, input: item.skill.test_cases[0].input },
        settings: { file_access_mode: "full_user_files", tool_idle_timeout_seconds: 300 },
      }),
    });
    if (!smoke.ok || smoke.execution_target !== executionTarget) throw new Error(`${item.skill.id}: ${executionTarget} smoke test failed`);
  }
  process.stdout.write(`PASS (${result.skill.verified_passed}/${result.skill.verified_total} visible, ${result.skill.hidden_test_result.passed}/${result.skill.hidden_test_result.total} hidden; ${item.skill.execution_targets.join(" + ")})\n`);
}

const registry = await api("/v1/skills?limit=100&sort=name");
const installed = new Set(registry.skills.map((skill) => skill.id));
const missing = skills.map((item) => item.skill.id).filter((id) => !installed.has(id));
if (missing.length) throw new Error(`ติดตั้งไม่ครบ: ${missing.join(", ")}`);

console.log(`ติดตั้ง security skills สำเร็จ ${skills.length}/${skills.length}; registry มีทั้งหมด ${registry.total} สกิล`);
