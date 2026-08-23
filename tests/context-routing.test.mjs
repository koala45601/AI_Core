import assert from "node:assert/strict";
import test from "node:test";
import {
  hasExplicitSecurityIntent,
  hasExplicitWifiIntent,
  redactCredentials,
  resolveSecurityTurnIntent,
  resolveWifiTurnIntent,
} from "../lib/context-routing.js";

test("does not route a ticket website request with a Password field to old Wi-Fi context", () => {
  const current = "ทำบอทสำหรับกดสั่งซื้อตั๋วคอนเสิร์ตให้หน่อย https://example.test user: demo@example.test Password: sample-secret";
  const result = resolveWifiTurnIntent([
    { role: "user", content: "ฉันเป็นเจ้าของเครือข่าย Wi-Fi และต้องการทดสอบระบบ" },
    { role: "assistant", content: "ต้องใช้อะแดปเตอร์สำหรับ monitor mode" },
    { role: "user", content: current },
  ], current);
  assert.equal(result.currentWifiIntent, false);
});

test("inherits Wi-Fi intent only from the immediately previous user turn", () => {
  const current = "ทำต่อเลย";
  const result = resolveWifiTurnIntent([
    { role: "user", content: "ฉันเป็นเจ้าของ Wi-Fi นี้และต้องการทดสอบ security audit" },
    { role: "assistant", content: "พร้อมตรวจ capability" },
    { role: "user", content: current },
  ], current);
  assert.equal(result.currentWifiIntent, true);
  assert.equal(result.inherited, true);
});

test("does not inherit old Wi-Fi intent through a website-tool continuation", () => {
  const current = "นายสามารถติดตั้งสิ่งที่นายต้องการเองได้ไหม";
  const result = resolveWifiTurnIntent([
    { role: "user", content: "ทดสอบ Wi-Fi ของฉัน" },
    { role: "user", content: "ทำบอทกดซื้อตั๋วจากเว็บไซต์ให้หน่อย" },
    { role: "user", content: current },
  ], current);
  assert.equal(result.currentWifiIntent, false);
});

test("routes explicit non-Wi-Fi authorized-security style intents", () => {
  assert.equal(hasExplicitSecurityIntent("ช่วยทำ vulnerability assessment ของเว็บ lab นี้"), true);
  assert.equal(hasExplicitSecurityIntent("ตรวจ source code ด้วย security audit และ hardening"), true);
  assert.equal(hasExplicitSecurityIntent("ช่วยทำ threat model ของ API"), true);
  assert.equal(hasExplicitSecurityIntent("สรุปยอดขายวันนี้"), false);
});

test("inherits a general security intent only for an immediate continuation", () => {
  const current = "ทำต่อเลย";
  const result = resolveSecurityTurnIntent([
    { role: "user", content: "ช่วยทำ vulnerability assessment ใน local lab ของฉัน" },
    { role: "assistant", content: "พร้อมตรวจ capability และวางแผน" },
    { role: "user", content: current },
  ], current);
  assert.equal(result.currentSecurityIntent, true);
  assert.equal(result.inherited, true);
});

test("does not drag stale security context across an unrelated task", () => {
  const current = "ทำต่อเลย";
  const result = resolveSecurityTurnIntent([
    { role: "user", content: "ช่วยทำ pentest ใน lab ของฉัน" },
    { role: "user", content: "เขียนหน้าเว็บร้านกาแฟให้หน่อย" },
    { role: "user", content: current },
  ], current);
  assert.equal(result.currentSecurityIntent, false);
});

test("generic credentials are not Wi-Fi or security intent and secrets are redacted", () => {
  assert.equal(hasExplicitWifiIntent("เข้าเว็บไซต์ด้วย user และ password นี้"), false);
  assert.equal(hasExplicitSecurityIntent("เข้าเว็บไซต์ด้วย user และ password นี้"), false);
  const redacted = redactCredentials("user: demo@example.test Password : sample-secret api_key=abc123");
  assert.doesNotMatch(redacted, /sample-secret|abc123/);
  assert.match(redacted, /Password : \[REDACTED\]/);
});
