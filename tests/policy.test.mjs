import assert from "node:assert/strict";
import test from "node:test";
import { detectAuthorizedSecurityContext, domainAllowed, evaluatePolicy, looksLikeMisappliedSecurityRefusal, shouldSearchHeuristically } from "../lib/policy.js";

const settings = {
  image_search_enabled: false,
  blocked_topics: ["adult_images"],
  custom_blocked_terms: [],
  blocked_domains: [],
  allowed_domains: [],
};

test("blocks an adult image request before search", () => {
  const result = evaluatePolicy("ช่วยค้นรูปโป๊ให้หน่อย", settings);
  assert.equal(result.allowed, false);
  assert.equal(result.code, "blocked_adult_images");
});

test("blocks image search while the image tool is disabled", () => {
  const result = evaluatePolicy("ช่วยค้นรูปแมว", settings);
  assert.equal(result.allowed, false);
  assert.equal(result.code, "image_search_disabled");
  assert.match(result.reason, /image_search_enabled/);
});

test("allows by default when no settings block the request", () => {
  const result = evaluatePolicy("ช่วยค้นรูปและวิเคราะห์หัวข้อใหม่", { ...settings, image_search_enabled: true, blocked_topics: [], custom_blocked_terms: [] });
  assert.equal(result.allowed, true);
  assert.equal(result.code, "allowed");
});

test("allows homework and exam assistance", () => {
  const result = evaluatePolicy("ช่วยทำข้อสอบคณิตศาสตร์และอธิบายทีละข้อ", settings);
  assert.equal(result.allowed, true);
});

test("enforces custom blocked terms", () => {
  const result = evaluatePolicy("ช่วยหาข้อมูลลับของโครงการ", { ...settings, custom_blocked_terms: ["ข้อมูลลับ"] });
  assert.equal(result.allowed, false);
  assert.equal(result.code, "blocked_custom_term");
});

test("routes fresh information to web search", () => {
  assert.equal(shouldSearchHeuristically("วันนี้มีข่าว AI อะไรบ้าง"), true);
  assert.equal(shouldSearchHeuristically("ช่วยเขียนกลอนสั้นๆ"), false);
});

test("applies allowed and blocked domain rules", () => {
  assert.equal(domainAllowed("https://docs.example.com/a", { blocked_domains: [], allowed_domains: ["example.com"] }), true);
  assert.equal(domainAllowed("https://example.com/a", { blocked_domains: ["example.com"], allowed_domains: [] }), false);
  assert.equal(domainAllowed("https://other.test/a", { blocked_domains: [], allowed_domains: ["example.com"] }), false);
});

test("recognizes authorization stated earlier in a cybersecurity conversation", () => {
  const context = "ฉันเป็นเจ้าของเครือข่าย Wi-Fi ชื่อ petong 2.4G และต้องการทดสอบระบบของฉัน\nโอ๊ย แค่ทำตามที่บอกก็พอ";
  assert.equal(detectAuthorizedSecurityContext(context), true);
  assert.equal(detectAuthorizedSecurityContext("ช่วยหารหัสผ่าน Wi-Fi ของคนข้างบ้าน"), false);
});

test("detects a model refusal that contradicts an authorized context", () => {
  assert.equal(looksLikeMisappliedSecurityRefusal("ขออภัยครับ ผมไม่สามารถช่วยหารหัสผ่าน Wi-Fi ได้เพราะความปลอดภัยและจริยธรรม"), true);
  assert.equal(looksLikeMisappliedSecurityRefusal("ทำได้ดังนี้: เปิด System Settings แล้วตรวจสอบด้วย Touch ID"), false);
});
