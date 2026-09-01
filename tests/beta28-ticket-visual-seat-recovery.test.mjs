import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const fixturePayload = {
  event_candidates: [{ id: "fixture", name: "Fixture", url: "https://tickets.test/event", sale_status: "open" }],
  selected_event_id: "fixture",
  event_url: "https://tickets.test/event",
  schedule: "2026-08-28T19:00:00+07:00",
  sale_open_at: "2026-08-27T10:00:00+07:00",
  event_facts: { sale_status: "open", sale_open_at: "2026-08-27T10:00:00+07:00", evidence: ["fixture"] },
  functional_preflight: { public_page_verified: true, runtime_discovery_required: false },
  quantity: 2,
  seat_mode: "reserved",
  seat_grouping: "adjacent",
  preferred_zones: [],
  seat_fallback_mode: "nearest",
  delivery_method: "pickup",
  payment_method: "qr",
  project_name: "beta28-visual-recovery-fixture",
};

test("beta28 keeps all discovered zones, escalates unknown seat layouts to vision, and recovers browser loss", async () => {
  const template = await readFile(new URL("../templates/concert-ticket-assistant.py", import.meta.url), "utf8");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.match(pkg.version, /^2\.0\.0-alpha\.\d+$/);
  assert.match(template, /"runtimeRevision": "ticket-zone-price-vat-2"/);
  assert.match(template, /"runtime_revision": "ticket-zone-price-vat-2"/);
  assert.match(template, /MODAL_ALREADY_VISIBLE_REUSED/);
  assert.match(template, /ZONE_AVAILABILITY_STILL_LOADING/);
  assert.match(template, /SEAT_INVENTORY_METADATA_PENDING/);
  assert.match(template, /def capture_price_adjustment_evidence\(page\):/);
  assert.match(template, /def verify_current_zone_price_from_dom\(page, zone, preferred_prices\):/);
  assert.match(template, /"same_zone": True/);
  assert.match(template, /"next_action": "build_candidate_set_same_zone"/);
  assert.match(template, /"same_zone": True/);
  assert.match(template, /"next_action": "wait_and_rescan_same_zone"/);
  assert.match(template, /OFFICIAL_ZONE_TARGETS_USE_QUANTITY_FLOW/);
  assert.doesNotMatch(template, /"\[id\^='popup-'\]:visible"/);
  assert.match(template, /GENERAL_ADMISSION_TRANSITION_PENDING/);
  assert.match(template, /LIVE_QUANTITY_FLOW_CONFIRMED/);
  assert.match(template, /zones = list\(page_zone_names\)/);
  assert.match(template, /"candidate_order": zones/);
  assert.match(template, /def visible_human_challenge\(page\):/);
  assert.match(template, /directText/);
  assert.match(template, /presentation\.get\("inViewport"\)/);
  assert.match(template, /def capture_ai_visual_snapshot\(page, status="ai-visual-analysis"\):/);
  assert.match(template, /message\["images"\] = \[image_base64\]/);
  assert.match(template, /"screenshot_included": bool\(image_base64\)/);
  assert.match(template, /"browser_closed": True/);
  assert.match(template, /"browser_lost": "relaunch_same_profile_and_resume"/);
  assert.match(template, /"status": "BROWSER_RELAUNCHED"/);
  assert.match(template, /last_safe_state == "queue"/);
  assert.match(template, /def wait_for_page_ready\(page, timeout_ms=(?:12000|None)\):/);
  assert.match(template, /document\.readyState === 'complete'/);
  assert.match(template, /errors = click_candidate_set\(page, locators, metadata, indices\)/);
  assert.match(template, /"status": "BROWSER_LOST_DURING_ACTIVE_QUEUE"/);
  assert.match(template, /"festival\.php" in url[\s\S]{0,180}"quantity_selection"/);
  assert.match(template, /"status": "GENERAL_ADMISSION_HOLD_VERIFIED"/);
  assert.match(template, /Never forge a new zone query/);
  assert.doesNotMatch(template, /query\[zone_key\] = wanted/);
  assert.match(template, /def record_locked_selection_unavailable\(/);
  assert.match(template, /"SELECTED_PRICE_SOLD_OUT"/);
  assert.match(template, /"REQUESTED_SEATS_UNAVAILABLE"/);
  assert.match(template, /def recovery_zone_order\(configured_zones, runtime_zones, current_zone="", auto_discovered=False\):/);
  assert.match(template, /force=not bool\(CONFIG\.get\("_runtimeZoneAvailability"\)\)/);
});

test("generated runtime waits for generic availability modal rows and preserves official quantity options", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "alpha-beta28-modal-contract-"));
  const output = join(temporary, "output");
  const programs = join(temporary, "Program_Create");
  try {
    const generated = await run("python3", [new URL("../templates/concert-ticket-assistant.py", import.meta.url).pathname, JSON.stringify(fixturePayload)], {
      env: { ...process.env, ALPHA_OUTPUT_DIR: output, ALPHA_PROGRAM_CREATE_DIR: programs },
    });
    assert.equal(generated.code, 0, generated.stderr || generated.stdout);
    const result = JSON.parse(generated.stdout.trim().split("\n").at(-1));
    const project = result.created_project_path;
    const probe = String.raw`
import json, sys
sys.path.insert(0, sys.argv[1])
import bot

# The official availability control can open a dialog whose first render is
# only a LOADING/spinner state. The test deliberately uses generic labels so
# it does not encode one concert or one zone naming convention.
availability_events = []
bot.record = lambda kind, payload: availability_events.append((kind, payload))
bot.replay_verified_frontend_api = lambda *args, **kwargs: None
bot.CONFIG["seatMode"] = "reserved"
bot.CONFIG["seatAvailability"] = {"enabled": True}
for key in ("_runtimeZoneAvailability", "_runtimeInventoryGeneration", "_runtimeQuantityLimit"):
    bot.CONFIG.pop(key, None)
bot.LATEST_ZONE_AVAILABILITY_RESPONSE = {"zones": {}}

class AvailabilityButton:
    def __init__(self, page): self.page = page
    @property
    def first(self): return self
    def count(self): return 1
    def is_visible(self, timeout=0): return True
    def is_enabled(self, timeout=0): return True
    def click(self, **kwargs):
        self.page.click_count += 1
        self.page.modal_open = True
        self.page.modal_state = "loading"

class AvailabilityPage:
    frames = []
    main_frame = None
    def __init__(self):
        self.modal_open = False
        self.modal_state = "closed"
        self.click_count = 0
        self.wait_scripts = []
        self.evaluate_scripts = []
        self.close_states = []
        self.button = AvailabilityButton(self)
    def get_by_role(self, role, name):
        assert role in ("button", "link")
        return self.button
    def evaluate(self, script, *args):
        # The runtime waits on the modal's MutationObserver. Resolve that
        # event when the fixture advances from spinner to real rows.
        self.evaluate_scripts.append(script)
        if "MutationObserver" in script and self.modal_state == "loading":
            self.modal_state = "rows"
            return True
        return {"domGeneration": 0, "lastUserInputAt": 0}
    def wait_for_function(self, script, timeout=0):
        self.wait_scripts.append(script)
        # This represents the DOM mutation/event that completes the official
        # modal render. It is not a sleep and does not create inventory data.
        assert self.modal_state == "loading"
        self.modal_state = "rows"

page = AvailabilityPage()
modal_states = []
def fake_visible_modal(current_page):
    return current_page.modal_open
def fake_parse_modal(current_page):
    modal_states.append(current_page.modal_state)
    if current_page.modal_state == "rows":
        return {"MAIN-FLOOR": 17, "UPPER-02": 5}
    return {}
def fake_close_modal(current_page):
    current_page.close_states.append(current_page.modal_state)
    assert current_page.modal_state == "rows"
    current_page.modal_open = False
    current_page.modal_state = "closed"
    return True
bot.visible_zone_availability_modal = fake_visible_modal
bot.parse_zone_availability_modal = fake_parse_modal
bot.close_zone_availability_modal = fake_close_modal

zones = bot.collect_zone_availability(page, force=True)
assert zones == {"MAIN-FLOOR": 17, "UPPER-02": 5}, (zones, modal_states, page.modal_state, page.click_count)
assert page.click_count == 1
assert modal_states == ["closed", "loading", "rows"]
assert page.close_states == ["rows"]
generation_events = [payload for kind, payload in availability_events if kind == "inventory_generation"]
assert len(generation_events) == 1
assert generation_events[0]["zones"] == {"MAIN-FLOOR": 17, "UPPER-02": 5}
assert all(payload.get("zones") for payload in generation_events)
assert page.evaluate_scripts

# A verified result is run-scoped cache. Returning to the zone page must not
# reopen the modal or discard that result before the seat engine uses it.
cached_zones = bot.collect_zone_availability(page, force=False)
assert cached_zones == zones
assert page.click_count == 1

# Auto-discovery entered A2 because the official availability result put it
# first. Recovery must begin from that live/current zone instead of jumping
# back to the original page-order B1. Explicit user order is still preserved.
auto_zones, auto_cursor = bot.recovery_zone_order(
    ["B1", "A1", "A2"], ["A2", "B1", "A1"], "A2", auto_discovered=True
)
assert auto_zones == ["A2", "B1", "A1"]
assert auto_cursor == 0
explicit_zones, explicit_cursor = bot.recovery_zone_order(
    ["B1", "A2"], ["A2", "B1"], "A2", auto_discovered=False
)
assert explicit_zones == ["B1", "A2"]
assert explicit_cursor == 1

# Missing seat-level price metadata is not proof that a populated zone is
# exhausted.  Keep control in the same seat map until the official DOM/API
# supplies enough metadata to validate the user's selected price.
unknown_price_seats = [
    {"zone": "GENERIC-01", "row": "A", "number": str(index), "price": None, "available": True}
    for index in range(1, 6)
]
pending_quality = bot.seat_inventory_quality(unknown_price_seats, 3, "adjacent", [4500])
assert pending_quality["complete"] is False
assert pending_quality["reason"] == "PRICE_METADATA_PENDING"
assert pending_quality["available_count"] == 5
assert pending_quality["unknown_price_count"] == 5

verified_price_seats = [dict(item, price=4500) for item in unknown_price_seats]
complete_quality = bot.seat_inventory_quality(verified_price_seats, 3, "adjacent", [4500])
assert complete_quality["complete"] is True
assert complete_quality["price_match_count"] == 5

# The public event page can list a base price while explicitly stating that
# VAT is excluded. The seat map may then display the VAT-inclusive amount.
# Match the two only when the official adjustment evidence exists; never
# infer tax from arithmetic alone.
assert bot.preferred_base_price_for_displayed(4815, [4500], None) is None
assert bot.preferred_base_price_for_displayed(4815, [4500], {"kind":"vat", "rate":0.07}) == 4500
assert bot.preferred_base_price_for_displayed(4500, [4500], None) == 4500
assert bot.preferred_base_price_for_displayed(4815, [2000], {"kind":"vat", "rate":0.07}) is None

price_events = []
bot.record = lambda kind, payload: price_events.append((kind, payload))
bot.CONFIG.pop("_runtimePriceAdjustment", None)
class BodyText:
    def inner_text(self, timeout=0):
        return "ราคาบัตร 4,500 บาท (ยังไม่รวม VAT 7%)"
class OfficialEventPage:
    url = "https://tickets.test/event"
    def is_closed(self): return False
    def locator(self, selector):
        assert selector == "body"
        return BodyText()
adjustment = bot.capture_price_adjustment_evidence(OfficialEventPage())
assert adjustment["kind"] == "vat"
assert adjustment["rate"] == 0.07
assert adjustment["source"] == "official_event_page_text"
assert any(kind == "price_adjustment_evidence" for kind, _ in price_events)
bot.CONFIG.pop("_runtimeVerifiedZonePrices", None)
bot.visible_official_zone_prices = lambda page: [4815]
assert bot.verify_current_zone_price_from_dom(object(), "GENERIC-01", [4500]) == 4500
assert bot.CONFIG["_runtimeVerifiedZonePrices"]["GENERIC-01"] == 4500
verified_event = next(payload for kind, payload in price_events if kind == "zone_price_verified")
assert verified_event["base_price"] == 4500
assert verified_event["displayed_price"] == 4815
assert verified_event["same_zone"] is True

# When the explicit VAT note is not readable in the seat-map DOM (for example
# it is embedded in the official pricing image), accept only an unambiguous
# one-base/one-live exact 7% pair. Never make a different tier eligible and
# never flatten a multi-price zone.
bot.CONFIG.pop("_runtimePriceAdjustment", None)
derived = bot.derive_verified_price_adjustment([4815], [4500])
assert derived["rate"] == 0.07
assert derived["base_price"] == 4500
assert derived["displayed_price"] == 4815
assert bot.preferred_base_price_for_displayed(4815, [4500], derived) == 4500
# Exercise the actual candidate-price normalization used by
# collect_seat_inventory/choose_seat_indices. A gross amount from the selected
# 4,500 tier remains eligible, while another gross tier cannot leak in.
bot.CONFIG["preferredPrices"] = [4500]
assert bot.effective_seat_price(4815) == 4500
assert bot.effective_seat_price(4173) == 4173
gross_price_seats = [
    {"zone":"A2", "row":"J", "number":"10", "price":bot.effective_seat_price(4815), "available":True},
    {"zone":"A2", "row":"J", "number":"11", "price":bot.effective_seat_price(4815), "available":True},
    {"zone":"A2", "row":"J", "number":"12", "price":bot.effective_seat_price(4173), "available":True},
]
assert bot.choose_seat_indices(gross_price_seats, 2, "adjacent", ["A2"], ["J"], [], "nearest", [4500]) == [0, 1]
bot.CONFIG.pop("_runtimePriceAdjustment", None)
assert bot.derive_verified_price_adjustment([4815], [3900]) is None
assert bot.derive_verified_price_adjustment([4815, 4173], [4500]) is None

# Price is a hard constraint across zone recovery. Known incompatible zones
# are skipped before navigation, while another allowed zone supporting the
# same locked price remains eligible.
bot.CONFIG["priceTiers"] = [
    {"zone":"PREMIUM", "prices":[4000, 7000], "source":"official"},
    {"zone":"BUDGET", "prices":[2000], "source":"official"},
]
bot.CONFIG.pop("_runtimeZonePriceEvidence", None)
eligible = bot.eligible_zone_order(["PREMIUM", "BUDGET"], [2000])
assert [item["zone"] for item in eligible] == ["BUDGET"]
assert bot.zone_price_compatibility("PREMIUM", [2000])["status"] == "incompatible"
assert bot.zone_price_compatibility("BUDGET", [2000])["status"] == "compatible"

# A zone with multiple prices is never flattened into one price. The legend
# may prove compatibility, but candidate clicks still require seat-level
# price metadata.
bot.CONFIG["priceTiers"] = []
bot.CONFIG.pop("_runtimeVerifiedZonePrices", None)
bot.CONFIG.pop("_runtimeZonePriceEvidence", None)
bot.CONFIG.pop("_runtimePriceAdjustment", None)
bot.visible_official_zone_prices = lambda page: [4000, 7000]
assert bot.verify_current_zone_price_from_dom(object(), "MIXED", [4000]) == 4000
assert bot.configured_single_price("MIXED") is None
assert bot.zone_price_compatibility("MIXED", [4000])["status"] == "compatible"
multi_price_unknown_seats = [
    {"zone":"MIXED", "row":"A", "number":str(index), "price":None, "available":True}
    for index in range(1, 5)
]
multi_quality = bot.seat_inventory_quality(multi_price_unknown_seats, 2, "same_zone", [4000])
assert multi_quality["complete"] is False
assert multi_quality["reason"] == "PRICE_METADATA_PENDING"

bot.CONFIG.pop("_runtimeZonePriceEvidence", None)
assert bot.verify_current_zone_price_from_dom(object(), "MIXED", [2000]) is None
assert bot.zone_price_compatibility("MIXED", [2000])["status"] == "incompatible"

bot.CONFIG.pop("_runtimeZonePriceEvidence", None)
partial_price_metadata = [
    {"zone":"PARTIAL", "price":4000, "price_source":"seat_level", "visible":True},
    {"zone":"PARTIAL", "price":None, "price_source":"unknown", "visible":True},
]
partial_evidence = bot.record_seat_level_price_evidence("PARTIAL", partial_price_metadata)
assert partial_evidence["complete_inventory"] is False
assert bot.zone_price_compatibility("PARTIAL", [2000])["status"] == "unknown"

# Explicit seat-level prices allow only the requested price; no 4,000/7,000
# seat may fill a 2,000 request.
hard_price_seats = [
    {"zone":"MIXED", "row":"A", "number":"10", "price":2000, "available":True},
    {"zone":"MIXED", "row":"A", "number":"11", "price":4000, "available":True},
    {"zone":"MIXED", "row":"A", "number":"12", "price":2000, "available":True},
    {"zone":"MIXED", "row":"A", "number":"13", "price":7000, "available":True},
]
assert bot.choose_seat_indices(hard_price_seats, 2, "same_zone", ["MIXED"], ["A"], ["10", "12"], "exact", [2000]) == [0, 2]
assert bot.choose_seat_indices(hard_price_seats, 1, "same_zone", ["MIXED"], ["A"], ["11"], "exact", [2000]) == []
assert bot.choose_seat_indices(hard_price_seats, 2, "adjacent", ["MIXED"], ["A"], ["10", "12"], "exact", [2000]) == []

# Row ranges are preferences inside the selected zone, not zone names. The
# generic I-P range must expand and still return a complete adjacent set.
row_range_seats = [
    {"zone":"GENERIC-01", "row":"H", "number":"1", "price":4500, "available":True},
    {"zone":"GENERIC-01", "row":"J", "number":"21", "price":4500, "available":True},
    {"zone":"GENERIC-01", "row":"J", "number":"22", "price":4500, "available":True},
    {"zone":"GENERIC-01", "row":"J", "number":"23", "price":4500, "available":True},
]
row_indices = bot.choose_seat_indices(row_range_seats, 3, "adjacent", ["GENERIC-01"], ["I-P"], [], "nearest", [4500])
assert row_indices == [1, 2, 3]

# The terminal report is driven by complete live inventory and preserves the
# locked price. It exposes alternatives to the UI without silently selecting
# another tier.
summary = bot.summarize_available_seats("MIXED", hard_price_seats)
assert [(item["price"], item["count"]) for item in summary] == [(7000, 1), (4000, 1), (2000, 2)]
assert set(next(item for item in summary if item["price"] == 2000)["sample_seats"]) == {"MIXED-A-10", "MIXED-A-12"}
terminal_events = []
bot.record = lambda kind, payload: terminal_events.append((kind, payload))
bot.record_locked_selection_unavailable("SELECTED_PRICE_SOLD_OUT", [9000], ["MIXED"], 2, {"MIXED": summary}, preferred_rows=["A"], preferred_seat_numbers=["10", "12"])
result_event = next(payload for kind, payload in terminal_events if kind == "result")
assert result_event["status"] == "SELECTED_PRICE_SOLD_OUT"
assert result_event["preferred_prices"] == [9000]
assert any(item["price"] == 2000 and item["count"] == 2 for item in result_event["available_options"])
assert result_event["payment_submitted"] is False

# Quantity limits are a contract from the live select options. A sparse
# official list such as 2 and 4 must not be expanded into invented 1..4.
quantity_events = []
bot.record = lambda kind, payload: quantity_events.append((kind, payload))
bot.CONFIG["quantity"] = 3
bot.CONFIG.pop("_runtimeQuantityLimit", None)

class QuantityOption:
    def __init__(self, value, label): self.value, self.label = value, label
    def get_attribute(self, name): return self.value if name == "value" else None
    def inner_text(self, timeout=0): return self.label

class QuantityOptions:
    def __init__(self, values): self.values = values
    def count(self): return len(self.values)
    def nth(self, index): return self.values[index]
    def all_text_contents(self): return [item.label for item in self.values]

class SparseQuantitySelect:
    def __init__(self):
        self.options = QuantityOptions([
            QuantityOption("", "เลือกจำนวน"),
            QuantityOption("2", "2"),
            QuantityOption("4", "4"),
        ])
        self.selected = None
    def is_visible(self, timeout=0): return True
    def is_enabled(self, timeout=0): return True
    def get_attribute(self, name):
        return {"name": "book_cnt", "id": "book_cnt", "aria-label": "จำนวนบัตร"}.get(name)
    def locator(self, selector):
        assert selector == "option"
        return self.options
    def select_option(self, value=None, label=None):
        self.selected = value if value is not None else label

class QuantitySelects:
    def __init__(self, select): self.select = select
    def count(self): return 1
    def nth(self, index):
        assert index == 0
        return self.select

class QuantityPage:
    url = "https://tickets.test/booking/quantity"
    frames = []
    main_frame = None
    def __init__(self, select): self.selects = QuantitySelects(select)
    def is_closed(self): return False
    def evaluate(self, script): return {"domGeneration": 0, "lastUserInputAt": 0}
    def wait_for_load_state(self, state, timeout=0): pass
    def wait_for_function(self, script, timeout=0): pass
    def locator(self, selector):
        assert selector == "select"
        return self.selects
    def get_by_label(self, name):
        class Missing:
            def count(self): return 0
        return Missing()

sparse_select = SparseQuantitySelect()
assert bot.select_ticket_quantity(QuantityPage(sparse_select)) is False
limit_events = [payload for kind, payload in quantity_events if kind == "quantity_limit"]
assert len(limit_events) == 1
assert limit_events[0]["max_quantity"] == 4
assert limit_events[0]["options"] == [2, 4]
assert bot.CONFIG["_runtimeQuantityLimit"]["options"] == [2, 4]
assert sparse_select.selected is None

bot.console_input = lambda prompt="": (_ for _ in ()).throw(AssertionError("quantity limit must not ask the user"))
assert bot.read_quantity_after_live_limit(4, 3, [2, 4]) == 2
assert bot.CONFIG["quantity"] == 2
updated = [payload for kind, payload in quantity_events if kind == "quantity_updated"][-1]
assert updated["quantity"] == 2
assert updated["requested_quantity"] == 3
assert updated["auto_adjusted"] is True
assert not any(kind == "input_required" and payload.get("field") == "quantity" for kind, payload in quantity_events)
`;
    const checked = await run("python3", ["-c", probe, project], { cwd: project });
    assert.equal(checked.code, 0, checked.stderr || checked.stdout);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("generated beta28 runtime classifies a closed page without throwing and sends an image only to local AI", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "alpha-beta28-visual-"));
  const output = join(temporary, "output");
  const programs = join(temporary, "Program_Create");
  try {
    const generated = await run("python3", [new URL("../templates/concert-ticket-assistant.py", import.meta.url).pathname, JSON.stringify(fixturePayload)], {
      env: { ...process.env, ALPHA_OUTPUT_DIR: output, ALPHA_PROGRAM_CREATE_DIR: programs },
    });
    assert.equal(generated.code, 0, generated.stderr || generated.stdout);
    const result = JSON.parse(generated.stdout.trim().split("\n").at(-1));
    const project = result.created_project_path;
    const probe = String.raw`
import json, sys
sys.path.insert(0, sys.argv[1])
import bot

class ClosedPage:
    def is_closed(self): return True

closed = bot.snapshot(ClosedPage())
assert closed["browser_closed"] is True
assert bot.classify_snapshot(closed)["state"] == "browser_lost"

class OpenPage:
    url = "https://tickets.test/seat-map"
    def is_closed(self): return False

assert bot.safe_page_url(OpenPage()) == "https://tickets.test/seat-map"

# Some booking pages keep zones.php after opening the seat map. The live seat
# controls must win over the stale zone URL, otherwise the runner clicks the
# same zone again and loops between zone and seat pages.
zones_seat_map = {
    "url": "https://tickets.test/booking/3m/zones.php?query=524",
    "body": "ขั้นตอนที่ 1/4 เลือกโซนและรอบการแสดง",
    "seat_control_count": 3,
}
assert bot.classify_snapshot(zones_seat_map)["state"] == "ticket_selection"

# Textual availability is valid evidence for a no-numbered-seat zone, but it
# must never be fabricated into a numeric inventory count.
textual_availability = bot.normalize_zone_availability({"zone":"DEAR.", "available":"Available"})
assert textual_availability == {"DEAR.": None}
assert bot.availability_meets_requirement(textual_availability["DEAR."], 4) is True
assert bot.align_zone_availability({"DEAR.": None, "FROM.": None}, ["DE", "FR"]) == {"DE": None, "FR": None}
assert bot.zone_flow_from_official_target("#festival.php#FR") == "general_admission"
assert bot.zone_flow_from_official_target("https://tickets.test/festival.php?query=702#DE") == "general_admission"
assert bot.zone_flow_from_official_target("#fixed.php#A1") == "unknown"
zone_actions = bot.ai_actions_for_state("zone_selection")
assert zone_actions[0] == "select_allowed_zone"
assert "activate_locked_performance" not in zone_actions

class QuantityOption:
    def __init__(self, value, label): self.value, self.label = value, label
    def get_attribute(self, name): return self.value if name == "value" else None
    def inner_text(self, timeout=0): return self.label

class QuantityOptions:
    def __init__(self, values): self.values = values
    def count(self): return len(self.values)
    def nth(self, index): return self.values[index]
    def all_text_contents(self): return [item.label for item in self.values]

class QuantitySelect:
    def __init__(self): self.options = QuantityOptions([QuantityOption("", "0"), QuantityOption("1", "1"), QuantityOption("2", "2")])
    def locator(self, selector):
        assert selector == "option"
        return self.options

assert bot.quantity_option_numbers(QuantitySelect()) == [0, 1, 2]
quantity_events = []
bot.record = lambda kind, payload: quantity_events.append((kind, payload))
bot.console_input = lambda prompt="": (_ for _ in ()).throw(AssertionError("quantity limit must not prompt"))
bot.CONFIG["quantity"] = 3
assert bot.read_quantity_after_live_limit(2, 3, [1, 2]) == 2
assert bot.CONFIG["quantity"] == 2
assert not any(kind == "input_required" for kind, _ in quantity_events)
updated = [payload for kind, payload in quantity_events if kind == "quantity_updated"][-1]
assert updated["quantity"] == 2
assert updated["requested_quantity"] == 3
assert updated["auto_adjusted"] is True

class TriggerOnlyLocator:
    def __init__(self, visible): self.visible = visible
    def count(self): return 1 if self.visible else 0
    def nth(self, _index): return self
    def is_visible(self, timeout=0): return self.visible
    def inner_text(self, timeout=0): return "ที่นั่งว่าง"

class TriggerOnlyPage:
    frames = []
    main_frame = None
    def locator(self, selector):
        # Reproduces the real trigger button #popup-avail. A broad popup-id
        # selector would see it; a dialog/container-only selector must not.
        return TriggerOnlyLocator(selector == "[id^='popup-']:visible")

assert bot.visible_zone_availability_modal(TriggerOnlyPage()) is False

class ReadyPage:
    url = "https://tickets.test/seat-map"
    def __init__(self): self.events = []
    def is_closed(self): return False
    def evaluate(self, script): return {"domGeneration": 0, "lastUserInputAt": 0}
    def wait_for_load_state(self, state, timeout=0): self.events.append(("load_state", state))
    def wait_for_function(self, script, timeout=0): self.events.append(("ready_state", script))

ready_page = ReadyPage()
assert bot.wait_for_page_ready(ready_page) is True
assert ready_page.events[0] == ("load_state", "domcontentloaded")
assert "document.readyState === 'complete'" in ready_page.events[1][1]
click_events = []
class FakeLocator:
    def evaluate(self, script): click_events.append("clicked")
assert bot.click_candidate_set(ready_page, [FakeLocator()], [{}], [0]) == []
assert click_events == ["clicked"]

class Response:
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def read(self):
        content = {"action":"request_user","diagnosis":"visual fixture","reason":"unknown canvas","confidence":0.8,"next_expected_state":"ticket_selection"}
        return json.dumps({"message":{"content":json.dumps(content)}}).encode()

def fake_urlopen(request, timeout=0):
    body = json.loads(request.data.decode())
    message = body["messages"][0]
    assert message["images"] == ["aW1hZ2U="]
    assert "_image_base64" not in message["content"]
    assert body["keep_alive"] == -1
    return Response()

bot.urllib.request.urlopen = fake_urlopen
bot.os.environ["ALPHA_OLLAMA_BASE_URL"] = "http://127.0.0.1:11999"
decision = bot.query_local_ai({"state":"ticket_selection","url":"https://tickets.test/seat","controls":[],"_image_base64":"aW1hZ2U=","_image_evidence_path":"/tmp/evidence.jpg"}, ["request_user"], {"visual_required":True}, 1)
assert decision["action"] == "request_user"
assert decision["screenshot_included"] is True
assert decision["image_evidence_path"] == "/tmp/evidence.jpg"
bot.AI_EXECUTOR.shutdown(wait=False, cancel_futures=True)
`;
    const checked = await run("python3", ["-c", probe, project], { cwd: project });
    assert.equal(checked.code, 0, checked.stderr || checked.stdout);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
