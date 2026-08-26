import argparse
import atexit
import getpass
import json
import os
import pathlib
import re
import socket
import subprocess
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

from state_machine import choose_seat_indices, classify_snapshot, next_action, verified_payment_handoff

ROOT = Path(__file__).resolve().parent
CONFIG = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
REPORT = ROOT / "run-report.jsonl"
ACTIONABLE_SELECTOR = "button, a[href], area[href], input[type=button], input[type=submit], input[type=image], [role=button], [role=link], [onclick]"
SEAT_SELECTOR = ".seatuncheck[data-seat][data-seatk], [data-seat][data-available='true'], [data-seat][data-status='available'], [role='button'][aria-label*='seat' i]"
OWNED_BROWSER_PROCESS = None


def record(kind, payload):
    item = {"at": datetime.now().astimezone().isoformat(), "kind": kind, **payload}
    with REPORT.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(item, ensure_ascii=False) + "\n")
    print(json.dumps(item, ensure_ascii=False), flush=True)


def capture_status_evidence(page, status):
    evidence_dir = Path(os.environ.get("ALPHA_TICKET_EVIDENCE_DIR") or (ROOT / "evidence"))
    evidence_dir.mkdir(parents=True, exist_ok=True)
    safe_status = re.sub(r"[^a-z0-9_-]+", "-", str(status).casefold()).strip("-") or "status"
    destination = evidence_dir / f"{datetime.now().astimezone().strftime('%Y%m%d-%H%M%S')}-{safe_status}.png"
    try:
        page.screenshot(path=str(destination), full_page=True)
        record("evidence", {"status": status, "path": str(destination), "url": page.url, "evidence_type": "screenshot"})
        return str(destination)
    except Exception as error:
        record("evidence_error", {"status": status, "error": str(error)[:500], "url": page.url})
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
        seats = page.locator(SEAT_SELECTOR)
        zone_match = re.search(r"[?&]zone=([^&#]+)", page.url, re.I)
        current_zone = (zone_match.group(1) if zone_match else "") or (zones[0] if zones else "")
        metadata = []
        for index in range(min(seats.count(), 1000)):
            seat = seats.nth(index)
            try:
                raw_seat = seat.get_attribute("data-seat") or ""
                parsed = re.match(r"^([A-Za-z]+)-(\d+)(?:-|$)", raw_seat)
                metadata.append({
                    "zone": seat.get_attribute("data-zone") or seat.get_attribute("data-section") or current_zone,
                    "row": seat.get_attribute("data-row") or (parsed.group(1) if parsed else ""),
                    "number": seat.get_attribute("data-seat-number") or (parsed.group(2) if parsed else raw_seat),
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
        surface_browser_window(page, browser_profile, "runtime_started")
        observed = {"retry_after": None, "http_status": None, "server_date": None}
        observed_api = set()
        login_submitted = False
        login_verified = False

        def on_response(response):
            value = response.headers.get("retry-after")
            if value and str(value).isdigit():
                observed["retry_after"] = int(value)
            if response.request.resource_type == "document":
                observed["http_status"] = response.status
                observed["server_date"] = response.headers.get("date") or observed["server_date"]
            elif response.request.resource_type in {"xhr", "fetch"}:
                parsed = urlsplit(response.url)
                safe_url = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
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
            input("ตรวจหน้าใน Chrome แล้วกลับมากด Enter เพื่อปิด หรือกดหยุดบอทจาก Alpha: ")
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
        pre_sale_rounds = 0
        discovery_rounds = 0
        workflow_steps = 0
        while True:
            checkpoint = classify_snapshot(snapshot(page, observed["retry_after"], observed["http_status"], observed["server_date"]), sale_open_at=CONFIG.get("saleOpenAt", ""))
            record("checkpoint", {**checkpoint, "next_action": next_action(checkpoint), "live": True})
            state = checkpoint["state"]
            if not login_verified and (authenticated_account_marker(page) or authenticated_booking_session(page, state)):
                login_verified = True
                record("authentication", {"status": "EXISTING_SESSION_VERIFIED", "method": "account_marker_or_private_booking_step", "credentials_persisted": False})
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
                selected_queue_entry = CONFIG.get("selectedPerformance") if isinstance(CONFIG.get("selectedPerformance"), dict) else {}
                activated_page = activate_selected_performance(page) if selected_queue_entry else None
                activated = bool(activated_page) if selected_queue_entry else semantic_click(page, ["Join waiting room", "Join the queue", "Join queue", "เข้าห้องรอ", "กดรับคิว", "รับคิว"])
                if not activated:
                    refreshed = classify_snapshot(snapshot(page, observed["retry_after"], observed["http_status"], observed["server_date"]), sale_open_at=CONFIG.get("saleOpenAt", ""))
                    record("recovery", {"status": "WAITING_ROOM_CONTROL_CHANGED", "previous_state": state, "current_state": refreshed["state"], "actionable_control_count": refreshed.get("actionable_control_count", 0)})
                    if refreshed["state"] != "waiting_room_entry":
                        checkpoint = refreshed
                        page.wait_for_timeout(500)
                        continue
                    record("result", {"status": "WAITING_ROOM_CONTROL_NOT_VERIFIED", "live_queue_observed": False, "live_checkout_verified": False, "reason": "visible control disappeared or could not be activated"})
                    context.close()
                    return 2
                if activated_page:
                    page = activated_page
                record("queue", {"status": "WAITING_ROOM_JOINED", "clicked_once": True, "same_session": True, "selected_schedule": CONFIG.get("schedule"), "selected_performance": CONFIG.get("selectedPerformance")})
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
                activated_page = activate_selected_performance(page, prefer_target_navigation=True)
                if not activated_page:
                    record("result", {"status": "SELECTED_PERFORMANCE_NOT_AVAILABLE", "reason": "ไม่พบปุ่มที่ตรงกับวัน/เวลาที่เลือก จึงไม่เลือกรอบอื่นแทน", "selected_performance": CONFIG.get("selectedPerformance"), "same_queue_session": True, "live_checkout_verified": False})
                    surface_browser_window(page, browser_profile, "waiting_selected_performance")
                    record("input_required", {"field": "performance", "stage": "waiting_selected_performance", "prompt": "เปิด Chrome ของบอทขึ้นหน้าแล้ว: รอบที่เลือกยังไม่ปรากฏ ระบบค้าง session เดิมไว้ให้ตรวจและจะไม่เลือกรอบอื่นแทน", "secret": False})
                    input("ตรวจรอบใน Chrome แล้วกด Enter เพื่อปิด โดยไม่เปลี่ยนไปรอบอื่น: ")
                    context.close()
                    return 2
                page = activated_page
                page.wait_for_timeout(1000)
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
                record("handoff", {"status": "SERVER_ACCESS_DENIED", "resume_supported": True, "same_session": True, "url": page.url})
                surface_browser_window(page, browser_profile, "waiting_access_denied")
                record("input_required", {"field": "access_denied", "stage": "waiting_access_denied", "prompt": "เว็บตอบ 403 และเปิด Chrome ของบอทค้างไว้แล้ว รอให้หน้าเว็บกลับมาใช้งานได้แล้วกดทำต่อ", "secret": False})
                input("เว็บตอบ 403 ระบบค้างหน้าต่างและ session ไว้ ไม่ยิงซ้ำ; เมื่อหน้าเว็บกลับมาแล้วกด Enter เพื่อทำต่อ: ")
                page.wait_for_timeout(500)
                continue
            if state == "login":
                login_url = page.url
                observed["http_status"] = None
                if not fill_login(page):
                    record("result", {"status": "LOGIN_FORM_NOT_VERIFIED", "live_checkout_verified": False})
                    context.close()
                    return 2
                login_submitted = True
                transitioned = wait_for_post_login_transition(page, login_url)
                after_login = classify_snapshot(snapshot(page, observed["retry_after"], observed["http_status"], observed["server_date"]), sale_open_at=CONFIG.get("saleOpenAt", ""))
                record("authentication", {"status": "POST_LOGIN_SETTLED" if transitioned else "POST_LOGIN_TIMEOUT", "from_url": login_url, "to_url": page.url, "state": after_login["state"], "credentials_persisted": False})
                if after_login["state"] == "login":
                    record("result", {"status": "LOGIN_FAILED_OR_FORM_STILL_VISIBLE", "live_checkout_verified": False, "credentials_persisted": False})
                    context.close()
                    return 2
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
                input("รับช่วงในหน้าต่าง Chrome เฉพาะขั้นนี้ แล้วกลับมากด Enter; บอทจะทำงานต่อด้วย session เดิม: ")
                page.wait_for_timeout(500)
                continue
            if state == "terms_conditions":
                record("handoff", {"status": "TERMS_ACCEPTANCE_REQUIRED", "resume_supported": True, "same_session": True, "url": page.url})
                surface_browser_window(page, browser_profile, "waiting_terms_acceptance")
                record("input_required", {"field": "terms", "stage": "waiting_terms_acceptance", "prompt": "อ่านเงื่อนไขของงานแล้วกดทำต่อเพื่อยอมรับและไปขั้นเลือกบัตร", "secret": False})
                input("อ่านเงื่อนไขใน Chrome แล้วกด Enter เพื่อยอมรับและทำต่อ: ")
                refreshed = classify_snapshot(snapshot(page, observed["retry_after"], observed["http_status"], observed["server_date"]), sale_open_at=CONFIG.get("saleOpenAt", ""))
                if refreshed["state"] != "terms_conditions":
                    record("recovery", {"status": "TERMS_COMPLETED_BY_USER", "current_state": refreshed["state"], "url": page.url})
                    continue
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
                    surface_browser_window(page, browser_profile, "waiting_checkout_options")
                    record("input_required", {"field": "checkout_options", "stage": "waiting_checkout_options", "prompt": "เปิด Chrome ของบอทขึ้นหน้าแล้ว เลือกวิธีรับบัตร/QR และกดทำต่อ", "secret": False})
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
                surface_browser_window(page, browser_profile, "payment_handoff")
                record("input_required", {"field": "payment", "stage": "payment_handoff", "prompt": "เปิด Chrome ของบอทขึ้นหน้าแล้ว: ถึงหน้าชำระเงินจริง ระบบหยุดก่อนจ่าย", "secret": False})
                input("ถึงหน้าชำระเงินจริงแล้ว ระบบหยุดก่อนจ่าย กด Enter เมื่อพี่ตรวจเสร็จ: ")
                context.close()
                return 0
            break
        record("result", {"status": "STOPPED_WITHOUT_VERIFIED_PAYMENT_HANDOFF", "state": checkpoint["state"], "live_checkout_verified": False})
        surface_browser_window(page, browser_profile, "waiting_review")
        record("input_required", {"field": "review", "stage": "waiting_review", "prompt": "เปิด Chrome ของบอทขึ้นหน้าแล้ว: หลักฐานยังไม่พอ ตรวจแล้วกดทำต่อเพื่อปิด", "secret": False})
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
