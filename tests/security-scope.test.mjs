import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyWifiPasswordRecoveryRequest,
  extractSecurityUrls,
  resolveOwnedUrlSecurityRequest,
  targetMatchesAuthorizedDomains,
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
