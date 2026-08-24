import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] || process.cwd());

async function update(relativePath, transform) {
  const filePath = resolve(appDir, relativePath);
  let source;
  try { source = await fs.readFile(filePath, "utf8"); }
  catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
  const next = transform(source);
  if (next === source) return false;
  const temporary = `${filePath}.beta14-ticket.tmp`;
  await fs.writeFile(temporary, next, "utf8");
  await fs.rename(temporary, filePath);
  return true;
}

function replaceRequired(source, before, after, alreadyPresent, label) {
  if (source.includes(alreadyPresent)) return source;
  if (!source.includes(before)) throw new Error(`หา ${label} ไม่พบ — หยุดแทนการ patch ผิดตำแหน่ง`);
  return source.replace(before, after);
}

const changed = [];

if (await update("lib/chat-store.ts", (source) => replaceRequired(
  source,
  `  learned_skill_id?: string;\n  error?: boolean;\n}`,
  `  learned_skill_id?: string;\n  error?: boolean;\n  inspected_url?: string;\n  pending_ticket_events?: Array<Record<string, unknown>>;\n  pending_ticket_build?: Record<string, unknown>;\n}`,
  "pending_ticket_build?: Record<string, unknown>",
  "ticket workflow message metadata",
))) changed.push("lib/chat-store.ts");

if (await update("app/api/chat/route.ts", (source) => {
  source = replaceRequired(
    source,
    `  const recentStored = await listRecentChatMessages(chat.id, 12);`,
    `  const recentStored = await listRecentChatMessages(chat.id, 12);\n  const latestTicketWorkflow = [...recentStored].reverse().find((item) => item.role === "assistant"\n    && (Array.isArray(item.metadata.pending_ticket_events) || Boolean(item.metadata.pending_ticket_build)));\n  const pendingTicketEvents = latestTicketWorkflow && !latestTicketWorkflow.metadata.pending_ticket_build\n    && Array.isArray(latestTicketWorkflow.metadata.pending_ticket_events)\n    ? latestTicketWorkflow.metadata.pending_ticket_events\n    : [];\n  const pendingTicketBuild = latestTicketWorkflow?.metadata.pending_ticket_build ?? null;`,
    "const latestTicketWorkflow =",
    "ticket workflow restoration",
  );

  const selectionBlock = `  if (pendingTicketEvents.length) {
    const numericChoice = Number(message.match(/^\\s*(\\d{1,3})\\b/)?.[1] || 0);
    const normalizedChoice = message.normalize("NFKC").toLowerCase().trim();
    const matchingByName = pendingTicketEvents.filter((event) => normalizedChoice.length >= 2 && String(event.name || "").normalize("NFKC").toLowerCase().includes(normalizedChoice));
    const selectedEvent = numericChoice > 0 && numericChoice <= pendingTicketEvents.length ? pendingTicketEvents[numericChoice - 1] : matchingByName.length === 1 ? matchingByName[0] : null;
    if (!selectedEvent) {
      const reply = "ยังจับคู่คอนที่พี่เลือกไม่ได้ครับ ตอบเป็นหมายเลข 1-" + pendingTicketEvents.length + " หรือพิมพ์ชื่อคอนตามรายการ";
      const assistant = await appendMessage({ chatId: chat.id, role: "assistant", content: reply, metadata: { pending_ticket_events: pendingTicketEvents, inspected_url: latestTicketWorkflow?.metadata.inspected_url } });
      return immediateStream([...baseEvents, { type: "status", payload: { stage: "ticket_event_selection", label: "รอเลือกคอนเสิร์ต" } }, { type: "token", payload: { text: reply } }, ...(assistant ? [{ type: "message_saved", payload: { message: assistant } }] : []), { type: "done", payload: {} }]);
    }
    const selectedUrl = String(selectedEvent.url || latestTicketWorkflow?.metadata.inspected_url || "");
    const browserEvents: ToolEvent[] = [{ type: "tool_status", payload: { tool: "browser_action", label: "กำลังตรวจรอบ โซน ที่นั่ง และฟอร์มของคอนที่เลือก" } }];
    try {
      if (selectedUrl) await executeTool("browser_action", { action: "open", url: selectedUrl }, settings);
      const form = await executeTool("browser_action", { action: "inspect_form" }, settings);
      const candidates = form.candidates && typeof form.candidates === "object" ? form.candidates as Record<string, Array<Record<string, unknown>>> : {};
      const optionText = (role: string) => (candidates[role] || []).flatMap((item) => Array.isArray(item.options) ? item.options : []).map((item) => String((item as Record<string, unknown>).text || "")).filter(Boolean).slice(0, 12);
      const schedules = optionText("schedule");
      const seats = optionText("seat_or_zone");
      const reply = [
        "เลือก “" + String(selectedEvent.name || "คอนเสิร์ตนี้") + "” แล้วครับ",
        schedules.length ? "รอบที่ตรวจพบ: " + schedules.join(", ") : "รอบ: พี่ต้องการวันและเวลาไหน?",
        seats.length ? "โซน/ประเภทบัตรที่ตรวจพบ: " + seats.join(", ") : "ที่นั่ง: ต้องการแบบระบุที่นั่ง/โซน หรือบัตรยืนไม่มีเลขที่นั่ง?",
        "บอกจำนวนบัตร โซน/งบ ชื่อผู้จอง ที่อยู่ และเลือก QR/PromptPay ได้เลย ข้อมูลใดที่หน้าเว็บไม่มีผมจะถามเฉพาะจุดนั้น",
      ].join("\\n\\n");
      const ticketBuild = { selected_event: selectedEvent, form_inspection: { url: form.url, title: form.title, candidates, ambiguous_roles: form.ambiguous_roles }, selected_event_id: selectedEvent.id, selected_event_name: selectedEvent.name, event_url: selectedUrl };
      const assistant = await appendMessage({ chatId: chat.id, role: "assistant", content: reply, metadata: { pending_ticket_build: ticketBuild, inspected_url: selectedUrl, tool_events: browserEvents.map(({ type, payload }) => ({ type, ...payload })) } });
      return immediateStream([...baseEvents, { type: "status", payload: { stage: "ticket_preferences", label: "รอข้อมูลสำหรับสร้างบอท" } }, ...browserEvents, { type: "token", payload: { text: reply } }, ...(assistant ? [{ type: "message_saved", payload: { message: assistant } }] : []), { type: "done", payload: {} }]);
    } catch (error) {
      const failure = "ตรวจฟอร์มคอนที่เลือกไม่สำเร็จ: " + (error instanceof Error ? error.message : "Browser Tool ไม่พร้อม");
      const assistant = await appendMessage({ chatId: chat.id, role: "assistant", content: failure, metadata: { error: true, pending_ticket_events: pendingTicketEvents, inspected_url: selectedUrl } });
      return immediateStream([...baseEvents, ...browserEvents, { type: "tool_error", payload: { tool: "browser_action", message: failure } }, ...(assistant ? [{ type: "message_saved", payload: { message: assistant } }] : []), { type: "done", payload: {} }]);
    }
  }
`;
  source = replaceRequired(
    source,
    `  const ticketBuilderIntent = matchedLearnedSkill?.id === "concert-ticket-purchase-assistant"`,
    `${selectionBlock}  const ticketBuilderIntent = Boolean(pendingTicketBuild) || matchedLearnedSkill?.id === "concert-ticket-purchase-assistant"`,
    "if (pendingTicketEvents.length)",
    "ticket choice continuation",
  );

  if (!source.includes("if (pendingTicketBuild ||")) {
    const localPlanner = `\n  if (!localPath && shouldPlanTools(message, directRead, browserHandled, learnedSkills)) {`;
    const standardPlanner = `\n  if (shouldPlanTools(message, directRead, browserHandled, learnedSkills)) {`;
    const plannerNeedle = source.includes(localPlanner) ? localPlanner : standardPlanner;
    const plannerCondition = source.includes(localPlanner)
      ? `if (pendingTicketBuild || (!localPath && shouldPlanTools(message, directRead, browserHandled, learnedSkills))) {`
      : `if (pendingTicketBuild || shouldPlanTools(message, directRead, browserHandled, learnedSkills)) {`;
    source = replaceRequired(
      source,
      plannerNeedle,
      `\n  if (pendingTicketBuild) {\n    conversation.push({ role: "system", content: "กำลังทำ workflow สร้างบอทบัตรคอนต่อเนื่อง ข้อมูลที่ตรวจแล้ว: " + JSON.stringify(pendingTicketBuild) + "\\nแปลงคำตอบล่าสุดของผู้ใช้เป็น input object รวมกับข้อมูลนี้ จากนั้นเรียก run_learned_skill โดยใช้ skill_id=concert-ticket-purchase-assistant และ execution_target=macos_host ถ้าข้อมูลยังขาดก็ยังต้องเรียกสกิลเพื่อให้มันคืน missing_preferences ห้ามเปลี่ยนหัวข้อ" });\n  }\n\n  ${plannerCondition}`,
      "if (pendingTicketBuild ||",
      "ticket build planner continuation",
    );
  }

  source = replaceRequired(
    source,
    `      if (!calls.length && iteration === 0 && matchedLearnedSkill) {\n        conversation.push({ role: "system", content: \`Intent Router จับคู่คำขอนี้กับสกิลที่ติดตั้งและเปิดใช้งานแล้ว: id=\${matchedLearnedSkill.id}, name=\${matchedLearnedSkill.name}. ต้องเรียก run_learned_skill โดยแปลงรายละเอียดจากคำขอเป็น input object ที่เหมาะสม ห้ามตอบว่าทำไม่ได้ก่อนลองสกิลนี้\` });`,
    `      if (!calls.length && iteration === 0 && (matchedLearnedSkill || pendingTicketBuild)) {\n        const routedSkillId = pendingTicketBuild ? "concert-ticket-purchase-assistant" : matchedLearnedSkill?.id;\n        const routedSkillName = pendingTicketBuild ? "Python Bot Builder — Concert Ticket" : matchedLearnedSkill?.name;\n        conversation.push({ role: "system", content: \`Intent Router จับคู่คำขอนี้กับสกิลที่ติดตั้งและเปิดใช้งานแล้ว: id=\${routedSkillId}, name=\${routedSkillName}. ต้องเรียก run_learned_skill โดยแปลงรายละเอียดจากคำขอเป็น input object ที่เหมาะสม ห้ามตอบว่าทำไม่ได้ก่อนลองสกิลนี้\` });`,
    "const routedSkillId = pendingTicketBuild",
    "ticket skill retry routing",
  );
  return source;
})) changed.push("app/api/chat/route.ts");

console.log(changed.length
  ? `Applied Alpha beta14 ticket workflow: ${changed.join(", ")}`
  : "Alpha beta14 ticket workflow already applied");
