/* global chrome */
const WS_BASE = "ws://127.0.0.1:4317/v1/extension";
let socket;
let reconnectTimer;
let keepAliveTimer;

function setBadge(connected) {
  chrome.action.setBadgeText({ text: connected ? "ON" : "" });
  chrome.action.setBadgeBackgroundColor({ color: connected ? "#1f7b5b" : "#888888" });
}

async function connect() {
  clearTimeout(reconnectTimer);
  const { alphaToolToken } = await chrome.storage.local.get("alphaToolToken");
  if (!alphaToolToken || socket?.readyState === WebSocket.OPEN) return;
  socket = new WebSocket(`${WS_BASE}?token=${encodeURIComponent(alphaToolToken)}`);
  socket.addEventListener("open", () => {
    setBadge(true);
    clearInterval(keepAliveTimer);
    keepAliveTimer = setInterval(() => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: "keepalive" })), 20_000);
  });
  socket.addEventListener("message", (event) => void onCommand(event.data));
  socket.addEventListener("close", () => {
    setBadge(false);
    clearInterval(keepAliveTimer);
    reconnectTimer = setTimeout(connect, 3_000);
  });
  socket.addEventListener("error", () => socket?.close());
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error("ไม่พบแท็บ Chrome ที่กำลังใช้งาน");
  return tab;
}

async function runInTab(tabId, func, args = []) {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  if (result?.result?.error) throw new Error(result.result.error);
  return result?.result;
}

function pageSnapshot() {
  const body = document.body?.innerText || "";
  return { ok: true, url: location.href, title: document.title, content: body.slice(0, 20_000) };
}

function clickTarget(selector, text) {
  const body = (document.body?.innerText || "").toLowerCase();
  if (/captcha|recaptcha|hcaptcha/.test(body)) return { ok: false, handoff_required: true, reason: "พบ CAPTCHA ต้องให้ผู้ใช้รับช่วง" };
  const elements = [...document.querySelectorAll("a, button, input[type=button], input[type=submit], [role=button]")];
  const element = selector ? document.querySelector(selector) : elements.find((item) => (item.innerText || item.value || "").toLowerCase().includes(String(text || "").toLowerCase()));
  if (!element) return { error: "ไม่พบองค์ประกอบที่ต้องการคลิก" };
  const context = `${element.innerText || element.value || ""} ${element.getAttribute("aria-label") || ""}`.toLowerCase();
  if (/pay|checkout|ชำระ|ซื้อ|confirm.order|submit.payment/.test(context)) return { ok: false, handoff_required: true, reason: "พบขั้นตอนชำระเงิน ต้องให้ผู้ใช้รับช่วง" };
  element.click();
  return { ok: true };
}

function typeTarget(selector, text) {
  const element = document.querySelector(selector || "input, textarea");
  if (!element) return { error: "ไม่พบช่องกรอกข้อมูล" };
  const type = String(element.type || "").toLowerCase();
  const detail = `${element.name || ""} ${element.autocomplete || ""} ${element.placeholder || ""}`.toLowerCase();
  if (type === "password" || /password|passcode|otp|one-time|cc-|card|cvv|บัตร|รหัสผ่าน/.test(detail)) {
    return { ok: false, handoff_required: true, reason: "รหัสผ่าน OTP หรือข้อมูลบัตรต้องให้ผู้ใช้กรอกเอง" };
  }
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
  if (setter) setter.call(element, String(text || "")); else element.value = String(text || "");
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  element.focus();
  return { ok: true };
}

async function uploadWithDebugger(tabId, selector, filePath) {
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  try {
    await chrome.debugger.sendCommand(target, "DOM.enable");
    const documentNode = await chrome.debugger.sendCommand(target, "DOM.getDocument", { depth: -1, pierce: true });
    const node = await chrome.debugger.sendCommand(target, "DOM.querySelector", { nodeId: documentNode.root.nodeId, selector });
    if (!node.nodeId) throw new Error("ไม่พบช่องอัปโหลดไฟล์");
    await chrome.debugger.sendCommand(target, "DOM.setFileInputFiles", { nodeId: node.nodeId, files: [filePath] });
    return { ok: true };
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

async function execute(action, args = {}) {
  if (action === "open") {
    const tab = args.new_tab === false ? await activeTab() : await chrome.tabs.create({ url: args.url, active: true });
    if (args.new_tab === false) await chrome.tabs.update(tab.id, { url: args.url });
    return { ok: true, url: args.url, title: tab.title || "" };
  }
  const tab = await activeTab();
  if (action === "snapshot") return runInTab(tab.id, pageSnapshot);
  if (action === "click" || action === "submit") {
    const clickResult = await runInTab(tab.id, clickTarget, [args.selector || "", args.text || (action === "submit" ? "submit" : "")]);
    if (clickResult?.handoff_required) return clickResult;
  } else if (action === "type") {
    const typeResult = await runInTab(tab.id, typeTarget, [args.selector || "", args.text || ""]);
    if (typeResult?.handoff_required) return typeResult;
  } else if (action === "scroll") {
    await runInTab(tab.id, (y) => { window.scrollBy({ top: Number(y || 700), behavior: "smooth" }); return { ok: true }; }, [args.y]);
  } else if (action === "download") {
    const result = await runInTab(tab.id, (selector, text) => {
      const links = [...document.querySelectorAll("a[href]")];
      const link = selector ? document.querySelector(selector) : links.find((item) => (item.innerText || "").toLowerCase().includes(String(text || "download").toLowerCase()));
      return link?.href ? { href: link.href, filename: link.getAttribute("download") || "" } : { error: "ไม่พบลิงก์ดาวน์โหลด" };
    }, [args.selector || "", args.text || ""]);
    if (result?.error) throw new Error(result.error);
    const id = await chrome.downloads.download({ url: result.href, filename: result.filename || undefined, saveAs: false });
    return { ok: true, download_id: id, note: "ไฟล์ถูกดาวน์โหลดด้วยการตั้งค่า Chrome" };
  } else if (action === "upload") {
    return uploadWithDebugger(tab.id, args.selector || "input[type=file]", args.file_path);
  } else {
    throw new Error(`ไม่รองรับคำสั่ง ${action}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  return runInTab(tab.id, pageSnapshot);
}

async function onCommand(raw) {
  let message;
  try { message = JSON.parse(raw); } catch { return; }
  if (!message.id) return;
  try {
    const result = await execute(message.action, message.args || {});
    socket?.send(JSON.stringify({ id: message.id, result }));
  } catch (error) {
    socket?.send(JSON.stringify({ id: message.id, result: { ok: false, error: error instanceof Error ? error.message : "Chrome ทำงานไม่สำเร็จ" } }));
  }
}

chrome.runtime.onInstalled.addListener(() => void connect());
chrome.runtime.onStartup.addListener(() => void connect());
chrome.storage.onChanged.addListener(() => void connect());
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
void connect();
