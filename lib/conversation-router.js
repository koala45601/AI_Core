const COMPLEX_TURN = /(ล่าสุด|วันนี้|ตอนนี้|ข่าว|ราคา|อากาศ|ค้น|เสิร์ช|เว็บ|internet|search|ไฟล์|โค้ด|โปรแกรม|สร้าง|แก้|รัน|เปิด|คลิก|ดาวน์โหลด|api|endpoint|docker|skill|สกิล|ฝึก|เรียนรู้|hack|wifi|wi-fi|password|รหัสผ่าน|security|pentest|audit|scan|สแกน|ติดตั้ง|install)/i;

const SOCIAL_INTENTS = [
  { intent: "presence", pattern: /^(?:อัลฟ่า|อัล|นาย|คุณ)?\s*(?:ยัง)?\s*(?:อยู่ไหม|อยู่มั้ย|อยู่ปะ|อยู่รึเปล่า|ว่างไหม|พร้อมไหม|ได้ยินไหม|ตอบหน่อย)[\s!?.ๆ]*$/i },
  { intent: "greeting", pattern: /^(?:สวัสดี|หวัดดี|ดีจ้า|ดีครับ|ดีค่ะ|ฮัลโหล|hello|hi|hey|โย่)[\s!?.ๆ]*$/i },
  { intent: "thanks", pattern: /^(?:ขอบคุณ(?:ครับ|ค่ะ)?|แต๊งกิ้ว|thank\s*you|thanks?)[\s!?.ๆ]*$/i },
  { intent: "acknowledgement", pattern: /^(?:โอเค|เค|รับทราบ|ได้เลย|เยี่ยม|เข้าใจแล้ว)[\s!?.ๆ]*$/i },
  { intent: "status", pattern: /^(?:อัลฟ่า|อัล|นาย|คุณ)?\s*(?:เป็นไง|โอเคไหม|ทำงานอยู่ไหม|ระบบพร้อมไหม)[\s!?.ๆ]*$/i },
];

export function classifyConversationTurn(message, options = {}) {
  const text = String(message || "").normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!text || options.forceSearch === true || /https?:\/\//i.test(text) || COMPLEX_TURN.test(text)) return { route: "model", intent: "complex" };
  const matched = SOCIAL_INTENTS.find((item) => item.pattern.test(text));
  if (matched) return { route: "instant", intent: matched.intent };
  // Ordinary questions use one local model call only. No search-classifier,
  // memory-retrieval, learned-skill inventory, or tool-planner round first.
  return { route: "local", intent: "conversation" };
}

export function instantConversationReply(intent) {
  if (intent === "presence") return "อยู่ครับ ว่ามาได้เลย";
  if (intent === "thanks") return "ยินดีครับ";
  if (intent === "acknowledgement") return "รับทราบครับ";
  if (intent === "status") return "พร้อมครับ ระบบทำงานอยู่ตามปกติ";
  return "สวัสดีครับ อัลฟ่าอยู่นี่ พร้อมช่วยเหมือนเดิม";
}
