function normalize(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

const EXPLICIT_WIFI_INTENT = /(?:\bwifi\b|wi-fi|wireless|เครือข่ายไร้สาย|ไวไฟ|ssid|802\.11|เราเตอร์|\brouter\b|handshake|monitor\s*mode|packet\s*injection|aircrack|hcxtools)/iu;
const EXPLICIT_SECURITY_INTENT = /(?:cybersecurity|cyber\s*security|security\s*(?:audit|assessment|test|testing|review)|pentest(?:ing)?|penetration\s*test(?:ing)?|vulnerability|ช่องโหว่|ทดสอบความปลอดภัย|ตรวจ(?:สอบ)?ความปลอดภัย|security\s*hardening|hardening|threat\s*model|fuzz(?:ing)?|red\s*team|ctf|exploit|proof[- ]of[- ]concept|\bpoc\b|port\s*scan|network\s*scan|service\s*scan|\bnmap\b|\bnikto\b|\bsemgrep\b|\btrivy\b|\bgitleaks\b|\baircrack\b|hcxtools|monitor\s*mode|packet\s*injection)/iu;
const CONTINUATION_INTENT = /(?:ทำตาม|ลงมือ|ทำเลย|เริ่มเลย|จัดการเลย|ต่อเลย|แค่นี้|ที่บอก|ดำเนินการต่อ|ติดตั้ง(?:สิ่ง|เครื่องมือ|โปรแกรม)?ที่.{0,40}(?:ต้องการ|บอก|ขาด)|go\s*ahead|do\s*it|continue|install\s+(?:it|that|what))/iu;
const WIFI_PROGRAM_BUILD_INTENT = /(?:(?:สร้าง|เขียน|ทำ|generate|create|build).{0,45}(?:โปรแกรม|ไฟล์|โค้ด|สคริปต์|script|tool|project)|(?:โปรแกรม|ไฟล์|โค้ด|script|tool|project).{0,45}(?:wifi|wi-fi|wireless|ไวไฟ|ssid))/iu;

export function hasExplicitWifiIntent(message) {
  return EXPLICIT_WIFI_INTENT.test(normalize(message));
}

export function hasExplicitSecurityIntent(message) {
  const text = normalize(message);
  return EXPLICIT_WIFI_INTENT.test(text) || EXPLICIT_SECURITY_INTENT.test(text);
}

export function isWifiProgramBuildRequest(message) {
  const text = normalize(message);
  return EXPLICIT_WIFI_INTENT.test(text) && WIFI_PROGRAM_BUILD_INTENT.test(text);
}

export function isContinuationRequest(message) {
  return CONTINUATION_INTENT.test(normalize(message));
}

function previousUserTurn(recentMessages, currentMessage) {
  const current = String(currentMessage ?? "").trim();
  const userTurns = (Array.isArray(recentMessages) ? recentMessages : [])
    .filter((item) => item?.role === "user" && typeof item.content === "string")
    .map((item) => item.content.trim());

  // The current turn is normally persisted before routing. Remove only that
  // final duplicate so a continuation inherits from the nearest user turn.
  if (userTurns.length && normalize(userTurns.at(-1)) === normalize(current)) userTurns.pop();
  return { current, previousUserMessage: userTurns.at(-1) ?? "" };
}

export function resolveWifiTurnIntent(recentMessages, currentMessage) {
  const { current, previousUserMessage } = previousUserTurn(recentMessages, currentMessage);
  const programBuild = isWifiProgramBuildRequest(current);
  const explicit = hasExplicitWifiIntent(current) && !programBuild;
  const previousProgramBuild = isWifiProgramBuildRequest(previousUserMessage);
  const inherited = !explicit && !programBuild && isContinuationRequest(current)
    && hasExplicitWifiIntent(previousUserMessage) && !previousProgramBuild;

  return {
    currentWifiIntent: explicit || inherited,
    explicit,
    inherited,
    programBuild,
    previousUserMessage,
    relevantContext: programBuild ? current : explicit ? current : inherited ? `${previousUserMessage}\n${current}` : "",
  };
}

export function resolveSecurityTurnIntent(recentMessages, currentMessage) {
  const { current, previousUserMessage } = previousUserTurn(recentMessages, currentMessage);
  const explicit = hasExplicitSecurityIntent(current);
  const inherited = !explicit && isContinuationRequest(current) && hasExplicitSecurityIntent(previousUserMessage);

  return {
    currentSecurityIntent: explicit || inherited,
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
