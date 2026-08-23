function normalize(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

const EXPLICIT_WIFI_INTENT = /(?:\bwifi\b|wi-fi|wireless|เครือข่ายไร้สาย|ไวไฟ|ssid|802\.11|เราเตอร์|\brouter\b|handshake|monitor\s*mode|packet\s*injection|aircrack|hcxtools)/iu;
const CONTINUATION_INTENT = /(?:ทำตาม|ลงมือ|ทำเลย|เริ่มเลย|จัดการเลย|ต่อเลย|แค่นี้|ที่บอก|ดำเนินการต่อ|ติดตั้ง(?:สิ่ง|เครื่องมือ|โปรแกรม)?ที่.{0,40}(?:ต้องการ|บอก|ขาด)|go\s*ahead|do\s*it|continue|install\s+(?:it|that|what))/iu;

export function hasExplicitWifiIntent(message) {
  return EXPLICIT_WIFI_INTENT.test(normalize(message));
}

export function isContinuationRequest(message) {
  return CONTINUATION_INTENT.test(normalize(message));
}

export function resolveWifiTurnIntent(recentMessages, currentMessage) {
  const current = String(currentMessage ?? "").trim();
  const userTurns = (Array.isArray(recentMessages) ? recentMessages : [])
    .filter((item) => item?.role === "user" && typeof item.content === "string")
    .map((item) => item.content.trim());

  // The current turn is normally persisted before routing. Remove only that
  // final duplicate so a continuation inherits from the nearest user turn.
  if (userTurns.length && normalize(userTurns.at(-1)) === normalize(current)) userTurns.pop();
  const previousUserMessage = userTurns.at(-1) ?? "";
  const explicit = hasExplicitWifiIntent(current);
  const inherited = !explicit && isContinuationRequest(current) && hasExplicitWifiIntent(previousUserMessage);

  return {
    currentWifiIntent: explicit || inherited,
    explicit,
    inherited,
    previousUserMessage,
    relevantContext: explicit ? current : inherited ? `${previousUserMessage}\n${current}` : "",
  };
}

export function redactCredentials(value) {
  return String(value ?? "")
    .replace(/(https?:\/\/)([^\s/:@]+):([^\s/@]+)@/gi, "$1[REDACTED]:[REDACTED]@")
    .replace(/\b(bearer\s+)[a-z0-9._~+\/-]+=*/gi, "$1[REDACTED]")
    .replace(/((?:password|passcode|pwd|รหัสผ่าน|otp|cvv|cvc|api[_ -]?key|access[_ -]?token|secret|private[_ -]?key)\s*[:=]\s*)([^\s,;]+)/gi, "$1[REDACTED]");
}
