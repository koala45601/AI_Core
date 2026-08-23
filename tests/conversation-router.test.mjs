import assert from "node:assert/strict";
import test from "node:test";
import { classifyConversationTurn, instantConversationReply } from "../lib/conversation-router.js";

test("Thai social turns use the instant route with natural predicates", () => {
  for (const message of ["อัลอยู่ไหม", "อัลฟ่าอยู่มั้ย", "อยู่ปะ", "ยังอยู่รึเปล่า", "พร้อมไหม", "ได้ยินไหม"]) {
    const result = classifyConversationTurn(message);
    assert.equal(result.route, "instant", message);
    assert.equal(result.intent, "presence", message);
    assert.match(instantConversationReply(result.intent), /^อยู่ครับ/);
    assert.doesNotMatch(instantConversationReply(result.intent), /^มีครับ/);
  }
});

test("instant replies stay concise and do not drag old task context into social turns", () => {
  const cases = new Map([
    ["สวัสดี", "greeting"],
    ["ขอบคุณครับ", "thanks"],
    ["โอเค", "acknowledgement"],
    ["ระบบพร้อมไหม", "status"],
  ]);
  for (const [message, intent] of cases) {
    const result = classifyConversationTurn(message);
    assert.deepEqual(result, { route: "instant", intent });
    const reply = instantConversationReply(result.intent);
    assert.ok(reply.length <= 60);
    assert.doesNotMatch(reply, /Wi-?Fi|รหัสผ่าน|Docker|สกิล|อยากให้ช่วยอะไร/i);
  }
});

test("knowledge, web, file, skill and security tasks never use canned social replies", () => {
  const messages = [
    "วันนี้ฝนตกไหม",
    "ช่วยค้นข่าวล่าสุด",
    "สร้างไฟล์ calculator.py",
    "เปิด https://example.com",
    "ทดสอบสกิลที่เพิ่งเรียน",
    "ตรวจ Wi-Fi ของฉัน",
    "อัลฟ่าอยู่ไหม แล้วค้นเว็บให้ด้วย",
  ];
  for (const message of messages) assert.equal(classifyConversationTurn(message).route, "model", message);
  assert.equal(classifyConversationTurn("อัลอยู่ไหม", { forceSearch: true }).route, "model");
});

