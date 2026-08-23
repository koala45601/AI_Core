import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] || process.cwd());
const marker = "alpha-beta7-file-workflow-recovery-v1";

function replaceOnce(source, needle, replacement, label) {
  if (!source.includes(needle)) throw new Error(`หา ${label} ไม่พบ — หยุดแทนการ patch ผิดตำแหน่ง`);
  return source.replace(needle, replacement);
}

async function patchToolService() {
  const path = resolve(appDir, "tool-service", "server.mjs");
  let source = await fs.readFile(path, "utf8");
  if (source.includes(marker)) return;

  const oldDestination = [
    "  const destination = allowedTarget(requestedDestination, settings, approved);",
    "  await assertNoSymlinkEscape(destination);",
  ].join("\n");

  const newDestination = [
    `  // ${marker}`,
    "  let destination;",
    "  try {",
    "    destination = allowedTarget(requestedDestination, settings, approved);",
    "  } catch (error) {",
    "    const reason = error instanceof Error ? error.message : String(error || \"\");",
    "    if (reason.includes(\"ตำแหน่งนี้อยู่นอกขอบเขตไฟล์ที่อนุญาต\")) {",
    "      return {",
    "        ok: false,",
    "        code: \"FILE_DESTINATION_OUT_OF_SCOPE\",",
    "        error: reason,",
    "        requested_destination: requestedDestination,",
    "        safe_fallback_destination: join(outputsDir, project),",
    "        file_access_mode: settings.file_access_mode || \"ask\",",
    "        requires_approval: settings.file_access_mode === \"ask\" && !approved,",
    "        host_scope: \"macos\",",
    "        docker_used: false,",
    "        message: \"ปลายทางที่ขออยู่นอกขอบเขตไฟล์ที่อนุญาต สามารถสร้างใน Alpha Outputs เป็น fallback ได้โดยไม่ใช้ Docker\",",
    "      };",
    "    }",
    "    throw error;",
    "  }",
    "  await assertNoSymlinkEscape(destination);",
  ].join("\n");

  source = replaceOnce(source, oldDestination, newDestination, "createFiles destination policy");

  const oldSuccess = "    return { ok: true, message: `สร้าง ${files.length} ไฟล์เรียบร้อย`, artifacts: created, destination };";
  const newSuccess = "    return { ok: true, message: `สร้าง ${files.length} ไฟล์เรียบร้อย`, artifacts: created, destination, host_scope: \"macos\", docker_used: false };";
  source = replaceOnce(source, oldSuccess, newSuccess, "createFiles success result");

  const temp = `${path}.beta7.tmp`;
  await fs.writeFile(temp, source, "utf8");
  await fs.rename(temp, path);
}

async function patchChatRoute() {
  const path = resolve(appDir, "app", "api", "chat", "route.ts");
  let source = await fs.readFile(path, "utf8");
  if (source.includes(marker)) return;
  if (!source.includes("alpha-beta4-loop-hardening-v1")) throw new Error("ต้อง apply beta4 loop hardening ก่อน beta7");
  if (!source.includes("alpha-beta6-host-filesystem-v1")) throw new Error("ต้อง apply beta6 host filesystem ก่อน beta7");

  const resultNeedle = [
    "        } catch (error) { result = { ok: false, error: error instanceof Error ? error.message : `${name} ทำงานไม่สำเร็จ` }; }",
    "",
    "        if (Array.isArray(result.results)) {",
  ].join("\n");

  const recoveryBlock = [
    "        } catch (error) { result = { ok: false, error: error instanceof Error ? error.message : `${name} ทำงานไม่สำเร็จ` }; }",
    "",
    `        // ${marker}`,
    "        if (name === \"create_files\" && result.code === \"FILE_DESTINATION_OUT_OF_SCOPE\" && workflowRequiresArtifact) {",
    "          const exactDestinationRequired = /(?:ต้อง|เฉพาะ|เท่านั้น|exact).{0,35}(?:path|พาธ|โฟลเดอร์|folder|ปลายทาง)|(?:path|พาธ|โฟลเดอร์|folder|ปลายทาง).{0,35}(?:ต้อง|เฉพาะ|เท่านั้น|exact)/i.test(message);",
    "          if (!exactDestinationRequired) {",
    "            const fallbackArgs: Record<string, unknown> = { ...args };",
    "            delete fallbackArgs.destination;",
    "            const requestedDestination = String(result.requested_destination || \"\");",
    "            await updateAgentRun(runId, { status: \"running\", stage: \"file_recovery\", label: \"ปลายทางเดิมอยู่นอกขอบเขต — กำลังสร้างไฟล์จริงใน Alpha Outputs\", tool: \"create_files\" });",
    "            toolEvents.push({ type: \"tool_status\", payload: { tool: \"create_files\", label: \"กำลัง retry บน macOS host ด้วยปลายทางที่อนุญาต\" } });",
    "            try {",
    "              const fallbackResult = await executeTool(\"create_files\", fallbackArgs, settings);",
    "              result = { ...fallbackResult, recovered_from_destination: requestedDestination, used_safe_fallback: true, host_scope: fallbackResult.host_scope || \"macos\", docker_used: false };",
    "            } catch (error) {",
    "              result = { ok: false, code: \"FILE_FALLBACK_CREATE_FAILED\", error: error instanceof Error ? error.message : \"สร้างไฟล์ fallback ไม่สำเร็จ\", requested_destination: requestedDestination, host_scope: \"macos\", docker_used: false };",
    "            }",
    "          } else {",
    "            result = { ...result, exact_destination_required: true, host_scope: \"macos\", docker_used: false };",
    "          }",
    "        }",
    "",
    "        if (Array.isArray(result.results)) {",
  ].join("\n");

  source = replaceOnce(source, resultNeedle, recoveryBlock, "tool result recovery insertion");

  const toolPromptNeedle = "- หลัง create_files สำเร็จ ต้องจำ path จากผล tool และบอกตำแหน่งไฟล์จริงในคำตอบ ห้ามเดาพาธ\n";
  if (source.includes(toolPromptNeedle)) {
    source = source.replace(toolPromptNeedle, toolPromptNeedle
      + "- ถ้า create_files คืน FILE_DESTINATION_OUT_OF_SCOPE ห้ามอ้าง Docker/container/sandbox หรือ external drive หลุด ให้ใช้ structured result และ retry ปลายทางที่อนุญาตตาม workflow เท่านั้น\n"
      + "- การสร้าง/ตรวจไฟล์ปกติเป็น host-native workflow; ห้ามอ้างว่าไฟล์อยู่ใน Container เว้นแต่ tool result จริงระบุ docker_used=true\n");
  }

  const temp = `${path}.beta7.tmp`;
  await fs.writeFile(temp, source, "utf8");
  await fs.rename(temp, path);
}

await patchToolService();
await patchChatRoute();
console.log("Applied Alpha beta7 file workflow recovery: structured destination errors, host fallback, and no-Docker file claims");
