const IMAGE_TERMS = [
  "รูป", "ภาพ", "รูปภาพ", "รูปถ่าย", "ค้นรูป", "สร้างภาพ", "image", "photo", "picture", "pic",
];

const CATEGORY_TERMS = {
  adult_content: ["โป๊", "เปลือย", "อนาจาร", "ลามก", "porn", "pornographic", "nude", "nsfw", "xxx"],
  illegal_activity: ["แฮกบัญชี", "ขโมยรหัส", "ฟอกเงิน", "ยาบ้า", "ขายยา", "hack account", "steal password", "money laundering"],
  weapons: ["ทำระเบิด", "ประกอบปืน", "ผลิตอาวุธ", "build a bomb", "make a gun", "weapon blueprint"],
  personal_data: ["เลขบัตรประชาชน", "รหัสผ่านของ", "ที่อยู่ส่วนตัวของ", "เบอร์ส่วนตัวของ", "social security number", "private address of"],
  gambling: ["เว็บพนัน", "สูตรสล็อต", "หวยล็อค", "casino exploit", "rigged lottery"],
};

function normalize(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function containsAny(text, terms) {
  return terms.some((term) => text.includes(term));
}

export function isImageRequest(message) {
  return containsAny(normalize(message), IMAGE_TERMS);
}

export function evaluatePolicy(message, settings) {
  const text = normalize(message);
  const topics = new Set(settings.blocked_topics ?? []);
  const adultTerms = CATEGORY_TERMS.adult_content;

  if (topics.has("adult_images") && containsAny(text, IMAGE_TERMS) && containsAny(text, adultTerms)) {
    return {
      allowed: false,
      code: "blocked_adult_images",
      setting: "blocked_topics: adult_images",
      reason: "ถูกบล็อกโดย setting blocked_topics: adult_images",
    };
  }

  if (isImageRequest(text) && settings.image_search_enabled !== true) {
    return {
      allowed: false,
      code: "image_search_disabled",
      setting: "image_search_enabled",
      reason: "ถูกบล็อกโดย setting image_search_enabled ซึ่งปิดอยู่",
    };
  }

  for (const [category, terms] of Object.entries(CATEGORY_TERMS)) {
    if (topics.has(category) && containsAny(text, terms)) {
      return {
        allowed: false,
        code: `blocked_${category}`,
        setting: `blocked_topics: ${category}`,
        reason: `ถูกบล็อกโดย setting blocked_topics: ${category}`,
      };
    }
  }

  const matchedTerm = (settings.custom_blocked_terms ?? [])
    .map(normalize)
    .filter(Boolean)
    .find((term) => text.includes(term));

  if (matchedTerm) {
    return {
      allowed: false,
      code: "blocked_custom_term",
      setting: `custom_blocked_terms: ${matchedTerm}`,
      reason: `ถูกบล็อกโดย setting custom_blocked_terms: “${matchedTerm}”`,
    };
  }

  return { allowed: true, code: "allowed", reason: "" };
}

const FRESHNESS_TERMS = [
  "ล่าสุด", "วันนี้", "ตอนนี้", "ปัจจุบัน", "เมื่อวาน", "พรุ่งนี้", "ปีนี้", "ข่าว", "ราคา", "สภาพอากาศ",
  "latest", "today", "current", "currently", "news", "price", "weather", "right now", "this year",
];

const SEARCH_TERMS = [
  "ค้นเว็บ", "ค้นหาให้", "หาในอินเทอร์เน็ต", "เช็กให้", "ตรวจสอบให้", "search the web", "look up", "browse",
];

export function shouldSearchHeuristically(message) {
  const text = normalize(message);
  return containsAny(text, FRESHNESS_TERMS) || containsAny(text, SEARCH_TERMS);
}

const SECURITY_CONTEXT_TERMS = [
  "wifi", "wi-fi", "wireless", "เครือข่าย", "เราเตอร์", "router", "รหัสผ่าน", "password",
  "hack", "pentest", "security", "cybersecurity", "ช่องโหว่", "exploit", "audit", "สแกน", "scan",
  "api", "endpoint", "devtools", "โปรแกรม", "ระบบ", "เว็บไซต์", "server", "เซิร์ฟเวอร์",
];

const OWNERSHIP_PATTERNS = [
  /(?:ฉัน|ผม|เรา)(?:เป็น)?เจ้าของ/u,
  /(?:ของฉัน|ของผม|ของเรา|ระบบเรา|เครือข่ายเรา|โปรแกรมเรา|เว็บเรา)/u,
  /(?:ได้รับอนุญาต|มีสิทธิ์ทดสอบ|ได้รับสิทธิ์|อนุญาตให้ทดสอบ)/u,
  /(?:my|our)\s+(?:own\s+)?(?:wifi|wi-fi|network|router|system|app|application|website|server|lab)\b/i,
  /\b(?:authorized|authorised|permission to test|owned by me|local lab|my lab)\b/i,
  /(?:lab|แล็บ|ห้องทดลอง)(?:ของฉัน|ของผม|ของเรา|จำลอง)?/iu,
];

export function detectAuthorizedSecurityContext(context) {
  const text = normalize(context);
  return containsAny(text, SECURITY_CONTEXT_TERMS) && OWNERSHIP_PATTERNS.some((pattern) => pattern.test(text));
}

export function looksLikeMisappliedSecurityRefusal(answer) {
  const text = normalize(answer).slice(0, 1800);
  const refusal = /(?:ขออภัย|เสียใจ).{0,100}(?:ไม่สามารถ|ช่วยไม่ได้)|ไม่สามารถ.{0,100}(?:เจาะ|แฮก|หารหัสผ่าน|รหัสผ่าน)|(?:ความปลอดภัย|จริยธรรม).{0,120}(?:ไม่สามารถ|ไม่ใช่)|ไม่ใช่ตัวช่วยในการละเมิด|(?:i(?:'m| am) sorry|i cannot|i can’t|unable to).{0,120}(?:hack|password|credential|network)/iu.test(text);
  const directHelp = /(?:ทำได้ดังนี้|เริ่มจาก|ขั้นตอน|คำสั่ง|command|ตรวจสอบด้วย|ทดสอบด้วย|เปิด terminal|system settings|router admin)/iu.test(text);
  return refusal && !directHelp;
}

export function domainAllowed(url, settings) {
  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }

  const blocked = settings.blocked_domains ?? [];
  if (blocked.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) return false;

  const allowed = settings.allowed_domains ?? [];
  if (!allowed.length) return true;
  return allowed.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}
