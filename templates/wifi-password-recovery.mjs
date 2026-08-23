#!/usr/bin/env node
import { spawn } from "node:child_process";

function usage() {
  console.error("Usage: node wifi-password-recovery.mjs <SSID>");
  process.exit(2);
}

const ssid = process.argv.slice(2).join(" ").trim();
if (!ssid) usage();
if (ssid.length > 128 || /[\0\r\n]/.test(ssid)) {
  console.error("SSID ไม่ถูกต้อง");
  process.exit(2);
}

// This uses the macOS Keychain API through the built-in `security` command.
// macOS may ask the signed-in user for approval/Touch ID before releasing a saved Wi-Fi password.
const child = spawn("/usr/bin/security", [
  "find-generic-password",
  "-D", "AirPort network password",
  "-a", ssid,
  "-gw",
], {
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
child.on("close", (code) => {
  if (code === 0 && stdout.trim()) {
    process.stdout.write(JSON.stringify({
      ok: true,
      ssid,
      source: "macOS Keychain",
      password: stdout.trim(),
    }) + "\n");
    return;
  }

  process.stdout.write(JSON.stringify({
    ok: false,
    ssid,
    source: "macOS Keychain",
    reason: stderr.trim() || "ไม่พบรหัสที่บันทึกไว้หรือผู้ใช้ไม่อนุญาตให้ Keychain เปิดเผยข้อมูล",
  }) + "\n");
  process.exitCode = 1;
});
