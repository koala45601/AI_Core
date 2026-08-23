function normalize(value) {
  return String(value ?? "").normalize("NFKC").trim();
}

export function extractSecurityUrls(message) {
  return [...new Set(normalize(message).match(/https?:\/\/[^\s<>()"']+/gi)?.map((url) => url.replace(/[.,!?;:\]]+$/, "")) ?? [])].slice(0, 5);
}

export function normalizeSecurityTarget(rawUrl) {
  const url = new URL(String(rawUrl || ""));
  if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("รองรับเฉพาะ HTTP/HTTPS");
  return {
    url: url.toString(),
    origin: url.origin,
    hostname: url.hostname.toLowerCase(),
  };
}

export function targetMatchesAuthorizedDomains(rawUrl, securityTestDomains = []) {
  const target = normalizeSecurityTarget(rawUrl);
  const domains = (Array.isArray(securityTestDomains) ? securityTestDomains : [])
    .map((item) => String(item).trim().toLowerCase())
    .filter(Boolean);
  return domains.some((domain) => target.hostname === domain || target.hostname.endsWith(`.${domain}`));
}

export function resolveOwnedUrlSecurityRequest(message, settings = {}) {
  const urls = extractSecurityUrls(message);
  if (!urls.length) return { securityUrlIntent: false, urls: [], authorized: false, reason: "no_url" };
  const authorized = urls.every((url) => targetMatchesAuthorizedDomains(url, settings.security_test_domains || []));
  return {
    securityUrlIntent: true,
    urls,
    authorized,
    reason: authorized ? "authorized_security_test_domain" : "target_not_authorized",
  };
}

export function classifyWifiPasswordRecoveryRequest(message) {
  const text = normalize(message).toLowerCase();
  const wifi = /(?:wifi|wi-fi|wireless|ไวไฟ|ssid|เครือข่ายไร้สาย)/iu.test(text);
  const password = /(?:password|passphrase|รหัสผ่าน|รหัส wifi|รหัสไวไฟ)/iu.test(text);
  const ownership = /(?:ของฉัน|ของผม|ของเรา|เราเตอร์ของฉัน|เครือข่ายของฉัน|my\s+(?:own\s+)?(?:wifi|network|router)|our\s+(?:wifi|network|router))/iu.test(text);
  const recover = /(?:หา|ดู|กู้|recover|retrieve|show|find|get)/iu.test(text);
  return {
    wifiPasswordIntent: wifi && password && recover,
    ownedContext: ownership,
    mode: wifi && password && recover && ownership ? "owned_wifi_password_recovery" : "none",
  };
}
