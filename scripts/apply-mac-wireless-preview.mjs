import { promises as fs } from "node:fs";

async function read(path) { return fs.readFile(path, "utf8"); }
async function write(path, content) { await fs.writeFile(path, content, "utf8"); }
function mustReplace(source, search, replacement, label) {
  if (!source.includes(search)) throw new Error(`Patch target not found: ${label}`);
  return source.replace(search, replacement);
}

// 1) Make the chat planner treat owned Wi-Fi lab requests as tool-using work,
// and remove the old deterministic answer that assumed an external adapter.
{
  const path = "app/api/chat/route.ts";
  let source = await read(path);

  source = mustReplace(
    source,
    '  const apiDiscoveryIntent = /(?:devtools|network tab|api|endpoint|xhr|fetch|graphql).{0,50}(หา|ค้น|จับ|ดู|วิเคราะห์|ทดสอบ|ยิง|discover|inspect|probe)|(?:หา|ค้น|จับ|วิเคราะห์|ทดสอบ|ยิง).{0,50}(?:api|endpoint|xhr|fetch|graphql)/i.test(message);\n  return fileIntent || apiDiscoveryIntent || matchesLearnedSkill(message, learnedSkills) || (wantsBrowser(message) && !browserHandled) || (!directRead && !browserHandled && /https?:\\/\\//i.test(message));',
    '  const apiDiscoveryIntent = /(?:devtools|network tab|api|endpoint|xhr|fetch|graphql).{0,50}(หา|ค้น|จับ|ดู|วิเคราะห์|ทดสอบ|ยิง|discover|inspect|probe)|(?:หา|ค้น|จับ|วิเคราะห์|ทดสอบ|ยิง).{0,50}(?:api|endpoint|xhr|fetch|graphql)/i.test(message);\n  const wirelessSecurityIntent = /(?:wifi|wi-fi|wireless|ไวไฟ|ssid|802\\.11).{0,80}(?:audit|security|ทดสอบ|ตรวจ|หา|password|รหัสผ่าน|capability|adapter|monitor)|(?:audit|security|ทดสอบ|ตรวจ|หา|password|รหัสผ่าน|capability|adapter|monitor).{0,80}(?:wifi|wi-fi|wireless|ไวไฟ|ssid|802\\.11)/i.test(message);\n  return fileIntent || apiDiscoveryIntent || wirelessSecurityIntent || matchesLearnedSkill(message, learnedSkills) || (wantsBrowser(message) && !browserHandled) || (!directRead && !browserHandled && /https?:\\/\\//i.test(message));',
    "wireless tool planning",
  );

  source = mustReplace(
    source,
    '  const deterministicWifiCapabilityGap = authorizedSecurityTurn && !hasInstalledWifiSkill;',
    '  // The old path returned a canned answer that assumed an external adapter.\n  // v1.1 preview instead lets the tool planner inspect the actual Mac first.\n  const deterministicWifiCapabilityGap = false;',
    "disable canned Wi-Fi capability gap",
  );

  const fnStart = source.indexOf("function authorizedSecurityCapabilityFallback(message: string): string {");
  const fnEnd = source.indexOf("\nfunction toolResultContent", fnStart);
  if (fnStart < 0 || fnEnd < 0) throw new Error("Patch target not found: authorizedSecurityCapabilityFallback function");
  const replacement = `function authorizedSecurityCapabilityFallback(message: string): string {\n  const wifi = /(?:wifi|wi-fi|wireless|เครือข่ายไร้สาย|เราเตอร์|router)/i.test(message);\n  if (wifi) {\n    return \`Capability unavailable: ยังไม่มีผลตรวจ capability จากเครื่องจริงในรอบนี้\n\nให้ตรวจ Wi-Fi ที่มีอยู่ใน Mac เครื่องนี้ก่อนเป็นอันดับแรก ห้ามสรุปว่าต้องใช้อะแดปเตอร์ภายนอกเพียงจากชนิดงาน ให้ตรวจ interface, macOS wireless framework/utility, สิทธิ์ และโปรแกรมที่ติดตั้งจริง แล้วใช้ของที่มีอยู่ก่อน หาก capability ที่ต้องใช้ขาดจริงจึงค่อยรายงานข้อจำกัดจากผล probe นั้น\n\nถ้าผู้ใช้ขอสร้างโปรแกรม ให้สร้างไฟล์จริงต่อได้และออกแบบโปรแกรมให้เริ่มจาก capability probe ของ Mac ไม่ใช่ Keychain หรือคำแนะนำซื้อ hardware\`;\n  }\n  return \`Capability unavailable: เครื่องมือสำหรับงานนี้ยังไม่มีผลตรวจจาก runtime ให้ตรวจ capability ที่มีอยู่จริงก่อน แล้วสร้าง/ใช้เครื่องมือที่เหมาะสมโดยไม่สมมติข้อจำกัดล่วงหน้า\`;\n}\n`;
  source = source.slice(0, fnStart) + replacement + source.slice(fnEnd);

  source = source.replace(
    "- สำหรับการกู้รหัสของอุปกรณ์ผู้ใช้ ให้เสนอเส้นทางที่ยืนยันผ่าน macOS/Router โดยผู้ใช้เอง และห้ามอ้างว่าอ่านรหัสสำเร็จถ้าไม่มีผลเครื่องมือ",
    "- งาน Wi-Fi lab ของผู้ใช้ โดยเฉพาะเครือข่ายที่ Mac ไม่เคยเชื่อม: ให้ตรวจ capability ของ Wi-Fi ภายใน Mac ก่อนเสมอ ห้ามหยุดที่ Keychain และห้ามสมมติว่าต้องใช้อุปกรณ์ภายนอกจนกว่าจะมีผล probe จริง; ห้ามอ้างผลสำเร็จถ้าไม่มีผลเครื่องมือ",
  );

  await write(path, source);
}

// 2) Expose a host-safe capability inventory tool to the model.
{
  const path = "lib/agent-tools.ts";
  let source = await read(path);
  const marker = '  {\n    type: "function",\n    function: {\n      name: "list_learned_skills",';
  const tool = `  {\n    type: "function",\n    function: {\n      name: "wireless_capability",\n      description: "Inspect the current Mac and its built-in Wi-Fi interface plus installed wireless utilities for an explicitly owned Wi-Fi lab. Always use this before claiming external hardware is required. This is capability inventory only; it does not attack nearby networks.",\n      parameters: {\n        type: "object",\n        properties: {\n          ssid: { type: "string", description: "Optional owned lab Wi-Fi name to look for during a passive target scan when the built-in macOS utility supports it" },\n        },\n      },\n    },\n  },\n`;
  if (!source.includes('name: "wireless_capability"')) source = mustReplace(source, marker, tool + marker, "wireless_capability tool schema");
  source = source.replace(
    '  api_discovery: "กำลังวิเคราะห์ Network และ API ของเว็บทดสอบ",',
    '  api_discovery: "กำลังวิเคราะห์ Network และ API ของเว็บทดสอบ",\n  wireless_capability: "กำลังตรวจ Wi‑Fi และ capability ของ Mac เครื่องนี้",',
  );
  source = source.replace(
    '- ใช้ api_discovery เมื่อผู้ใช้ต้องการหา endpoint/method/schema แบบ DevTools หรือ probe API ของเว็บตนเอง โดเมนต้องอยู่ใน Security Test Domains และห้ามใส่ credential ลง arguments',
    '- ใช้ api_discovery เมื่อผู้ใช้ต้องการหา endpoint/method/schema แบบ DevTools หรือ probe API ของเว็บตนเอง โดเมนต้องอยู่ใน Security Test Domains และห้ามใส่ credential ลง arguments\n- งาน Wireless Security Lab ของผู้ใช้ต้องเรียก wireless_capability ก่อน เพื่อสำรวจ Wi-Fi ภายใน Mac, interface, macOS utilities และโปรแกรมที่ติดตั้งจริง ใช้ hardware ที่มีอยู่เป็นค่าเริ่มต้น ห้ามแนะนำอะแดปเตอร์ภายนอกจนกว่าผล probe จะยืนยันว่า capability ที่ต้องใช้ไม่มี',
  );
  await write(path, source);
}

// 3) Add the actual Mac host capability probe to Tool Service.
{
  const path = "tool-service/server.mjs";
  let source = await read(path);
  const marker = "async function executeTool(name, args, settings, approved = false, signal) {";
  if (!source.includes("async function wirelessCapability(args = {})")) {
    const fn = `async function wirelessCapability(args = {}) {\n  const ssid = String(args.ssid || "").normalize("NFKC").trim().slice(0, 128);\n  const ports = await run("/usr/sbin/networksetup", ["-listallhardwareports"], { timeout: 8000, allowFailure: true });\n  const blocks = ports.stdout.split(/\\n\\n+/);\n  const wifiBlock = blocks.find((block) => /Hardware Port: (?:Wi-Fi|AirPort)/i.test(block)) || "";\n  const interfaceName = wifiBlock.match(/Device:\\s*(\\S+)/i)?.[1] || "";\n\n  const candidates = {\n    wdutil: ["/usr/bin/wdutil"],\n    tcpdump: ["/usr/sbin/tcpdump"],\n    airport: [\n      "/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport",\n      "/System/Library/PrivateFrameworks/Apple80211.framework/Versions/A/Resources/airport",\n    ],\n    aircrack_ng: ["/opt/homebrew/bin/aircrack-ng", "/usr/local/bin/aircrack-ng"],\n    hcxdumptool: ["/opt/homebrew/bin/hcxdumptool", "/usr/local/bin/hcxdumptool"],\n    hcxpcapngtool: ["/opt/homebrew/bin/hcxpcapngtool", "/usr/local/bin/hcxpcapngtool"],\n    brew: ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"],\n  };\n\n  const tools = {};\n  for (const [name, paths] of Object.entries(candidates)) {\n    let found = "";\n    for (const candidate of paths) {\n      if (await fs.stat(candidate).then((stat) => stat.isFile()).catch(() => false)) { found = candidate; break; }\n    }\n    tools[name] = { installed: Boolean(found), path: found };\n  }\n\n  const sw = await run("/usr/bin/sw_vers", [], { timeout: 5000, allowFailure: true });\n  const profiler = await run("/usr/sbin/system_profiler", ["SPAirPortDataType"], { timeout: 15_000, allowFailure: true });\n  let target = { ssid, scan_attempted: false, discovered: false, bssid: "", scan_error: "" };\n\n  if (ssid && tools.airport.installed) {\n    target.scan_attempted = true;\n    const scan = await run(tools.airport.path, ["-s"], { timeout: 15_000, allowFailure: true });\n    if (scan.code === 0) {\n      const line = scan.stdout.split("\\n").find((item) => item.trim().startsWith(ssid) || item.includes(ssid));\n      if (line) {\n        target.discovered = true;\n        target.bssid = line.match(/(?:[0-9a-f]{2}:){5}[0-9a-f]{2}/i)?.[0]?.toLowerCase() || "";\n      }\n    } else {\n      target.scan_error = (scan.stderr || scan.stdout).trim().slice(0, 1000);\n    }\n  }\n\n  return {\n    ok: true,\n    mode: "mac_first_capability_inventory",\n    macos: sw.stdout.trim(),\n    internal_wifi: { detected: Boolean(interfaceName), interface: interfaceName, hardware_port: wifiBlock.trim().slice(0, 1000) },\n    tools,\n    target,\n    wireless_profile: profiler.stdout.trim().slice(0, 6000),\n    monitor_capture: {\n      status: "not_verified",\n      note: "มีตัวรับสัญญาณ Wi-Fi ภายใน Mac แล้ว แต่การมี interface ไม่เท่ากับยืนยัน raw 802.11 monitor/injection capability; ต้อง probe runtime จริงก่อนสรุปข้อจำกัด",\n    },\n    policy: {\n      use_internal_hardware_first: true,\n      external_adapter_required: false,\n      external_adapter_note: "อย่าแนะนำอุปกรณ์ภายนอกจนกว่าจะมีผล probe จริงว่าความสามารถที่ต้องใช้ไม่มีบน hardware/OS ปัจจุบัน",\n    },\n  };\n}\n\n`;
    source = mustReplace(source, marker, fn + marker, "wireless capability implementation");
  }
  source = source.replace(
    '  if (name === "api_discovery") return apiDiscovery(args, settings);',
    '  if (name === "api_discovery") return apiDiscovery(args, settings);\n  if (name === "wireless_capability") return wirelessCapability(args);',
  );
  await write(path, source);
}

// 4) Move preview version so the UI proves the patch is actually loaded.
{
  const path = "package.json";
  const pkg = JSON.parse(await read(path));
  pkg.version = "1.1.0-beta.2";
  await write(path, `${JSON.stringify(pkg, null, 2)}\n`);
}

console.log("Applied Alpha v1.1.0-beta.2 Mac-first wireless capability patch");
