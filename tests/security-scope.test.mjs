import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyWifiPasswordRecoveryRequest,
  extractSecurityUrls,
  normalizeWifiTarget,
  resolveOwnedUrlSecurityRequest,
  resolveWifiLabTarget,
  targetMatchesAuthorizedDomains,
  wifiTargetMatchesAuthorizedScope,
} from "../lib/security-scope.js";

test("extracts a URL supplied for security testing", () => {
  assert.deepEqual(extractSecurityUrls("ทดสอบ https://lab.example.test/login ให้หน่อย"), ["https://lab.example.test/login"]);
});

test("authorizes only configured security test domains", () => {
  assert.equal(targetMatchesAuthorizedDomains("https://app.example.test/a", ["example.test"]), true);
  assert.equal(targetMatchesAuthorizedDomains("https://evil.test/a", ["example.test"]), false);
});

test("URL security request is authorized when every target is in scope", () => {
  const result = resolveOwnedUrlSecurityRequest("เจาะระบบของฉัน https://app.example.test", {
    security_test_domains: ["example.test"],
  });
  assert.equal(result.securityUrlIntent, true);
  assert.equal(result.authorized, true);
  assert.equal(result.reason, "authorized_security_test_domain");
});

test("URL security request is rejected from active scope when target is not listed", () => {
  const result = resolveOwnedUrlSecurityRequest("ทดสอบ https://other.test", {
    security_test_domains: ["example.test"],
  });
  assert.equal(result.authorized, false);
  assert.equal(result.reason, "target_not_authorized");
});

test("accepts Wi-Fi target with SSID only and treats BSSID as optional", () => {
  const target = normalizeWifiTarget({ ssid: "Alpha-Lab-Test" });
  assert.equal(target.ssid, "Alpha-Lab-Test");
  assert.equal(target.bssid, null);
  assert.equal(target.identity_mode, "ssid_only");
});

test("normalizes an optional BSSID when supplied", () => {
  const target = normalizeWifiTarget({ ssid: "Alpha-Lab-Test", bssid: "AA-BB-CC-DD-EE-FF" });
  assert.equal(target.bssid, "aa:bb:cc:dd:ee:ff");
  assert.equal(target.identity_mode, "ssid_bssid");
});

test("SSID-only authorized target can be registered before BSSID discovery", () => {
  assert.equal(wifiTargetMatchesAuthorizedScope(
    { ssid: "Alpha-Lab-Test" },
    [{ ssid: "Alpha-Lab-Test" }],
  ), true);
  const result = resolveWifiLabTarget({ ssid: "Alpha-Lab-Test" }, {
    security_test_wifi_targets: [{ ssid: "Alpha-Lab-Test" }],
  });
  assert.equal(result.authorized, true);
  assert.equal(result.bssid_required_before_active_test, true);
});

test("BSSID pinning prevents a different AP from inheriting the same SSID scope", () => {
  assert.equal(wifiTargetMatchesAuthorizedScope(
    { ssid: "Alpha-Lab-Test", bssid: "aa:bb:cc:dd:ee:01" },
    [{ ssid: "Alpha-Lab-Test", bssid: "aa:bb:cc:dd:ee:ff" }],
  ), false);
});

test("recognizes owned Wi-Fi password recovery as the first security-program intent", () => {
  const result = classifyWifiPasswordRecoveryRequest("ช่วยเขียนโปรแกรมหารหัสผ่าน Wi-Fi ของฉันให้หน่อย");
  assert.equal(result.wifiPasswordIntent, true);
  assert.equal(result.ownedContext, true);
  assert.equal(result.mode, "owned_wifi_password_recovery");
});

test("does not mark an unowned Wi-Fi password request as owned recovery", () => {
  const result = classifyWifiPasswordRecoveryRequest("หารหัสผ่าน Wi-Fi ข้างบ้านให้หน่อย");
  assert.equal(result.mode, "none");
});
