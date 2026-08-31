import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] || process.cwd());

async function update(relativePath, transform) {
  const filePath = resolve(appDir, relativePath);
  const source = await fs.readFile(filePath, "utf8");
  const next = transform(source);
  if (next === source) return false;
  const temporary = `${filePath}.beta14.tmp`;
  await fs.writeFile(temporary, next, "utf8");
  await fs.rename(temporary, filePath);
  return true;
}

function replaceRequired(source, before, after, alreadyPresent, label) {
  if (source.includes(alreadyPresent)) return source;
  if (!source.includes(before)) throw new Error(`หา ${label} ไม่พบ — หยุดแทนการ patch ผิดตำแหน่ง`);
  return source.replace(before, after);
}

const workerRepairs = [
  ["export async function designSkillGoal(", "export async function designHiddenSkillTests(", 'const deepWorker = { think: false, numCtx: Math.min(8192, Math.max(4096, settings.max_context_tokens || 8192)), numPredict: Math.min(1200, settings.max_output_tokens), timeoutMs: 240_000 };'],
  ["export async function designHiddenSkillTests(", "export async function buildSkillAttempt(", 'const deepWorker = { think: false, numCtx: Math.min(8192, Math.max(4096, settings.max_context_tokens || 8192)), numPredict: Math.min(1000, settings.max_output_tokens), timeoutMs: 240_000 };'],
  ["export async function buildSkillAttempt(", "export async function synthesizeResearchRound(", 'const deepWorker = { think: false, numCtx: Math.min(settings.max_context_tokens, 8192), numPredict: Math.min(3200, Math.max(1800, settings.max_output_tokens * 2)), timeoutMs: 360_000 };'],
  ["export async function synthesizeResearchRound(", "export async function unloadModel(", "const deepWorker = deepWorkerOptions(settings, Math.min(settings.max_output_tokens, 1200));"],
];

const changed = [];

if (await update("lib/ollama.ts", (source) => {
  for (const [startNeedle, endNeedle, healthy] of workerRepairs) {
    const start = source.indexOf(startNeedle);
    const end = source.indexOf(endNeedle, start + startNeedle.length);
    if (start < 0 || end < 0) throw new Error(`หา worker section ${startNeedle} ไม่พบ`);
    const section = source.slice(start, end);
    if (section.includes(healthy)) continue;
    const legacy = section.match(/const deepWorker = deepWorkerOptions\(settings, (?:deepWorker\.numPredict|Math\.min\([^;]+)\);/);
    if (!legacy && section.includes("think: false") && section.includes("options:")) continue;
    if (!legacy) throw new Error(`worker ${startNeedle} ไม่มี initializer ที่รู้จัก`);
    source = source.slice(0, start) + section.replace(legacy[0], healthy) + source.slice(end);
  }
  source = source
    .replace("options: { num_ctx: deepWorker.numCtx, num_predict: Math.min(2600, settings.max_output_tokens + 1000), temperature: planAttempt === 1 ? 0.15 : 0 },", "options: { num_ctx: deepWorker.numCtx, num_predict: deepWorker.numPredict, temperature: planAttempt === 1 ? 0.1 : 0 },")
    .replace("options: { num_ctx: deepWorker.numCtx, num_predict: Math.min(3000, Math.max(1200, settings.max_output_tokens * 2)), temperature: 0.35 },", "options: { num_ctx: deepWorker.numCtx, num_predict: deepWorker.numPredict, temperature: 0.15 },")
    .replace("options: { num_ctx: deepWorker.numCtx, num_predict: Math.min(4200, Math.max(2400, settings.max_output_tokens * 2)), temperature: 0.2 },", "options: { num_ctx: deepWorker.numCtx, num_predict: deepWorker.numPredict, temperature: 0.15 },");
  source = replaceRequired(
    source,
    "  const previousSource = JSON.stringify(previousFiles || []).slice(0, 24_000);",
    `  const sourceBudget = 16_000;
  const perFileBudget = Math.max(1_500, Math.floor(sourceBudget / Math.max(1, previousFiles.length)));
  const promptFiles = previousFiles.map((file) => {
    if (file.content.length <= perFileBudget) return file;
    const headLength = Math.floor(perFileBudget * 0.55);
    const tailLength = perFileBudget - headLength;
    return {
      ...file,
      content: \`${"${file.content.slice(0, headLength)}"}\\n# ... source middle omitted from repair prompt ...\\n${"${file.content.slice(-tailLength)}"}\`,
    };
  });
  const previousSource = JSON.stringify(promptFiles);`,
    "const sourceBudget = 16_000;",
    "context-safe previous source",
  );
  source = replaceRequired(
    source,
    '- argv[1] คือ JSON serialization ของ test.input ทั้ง object: ต้อง json.loads/process JSON เพียงครั้งเดียวแล้วอ่าน field จาก object นั้น เช่น payload["json_content"] และ payload["required_keys"] ห้ามส่ง argv[1] ทั้งก้อนไปเป็นค่า field เดียว',
    '- argv[1] คือ JSON serialization ของ test.input ทั้ง object: ต้อง json.loads/process JSON เพียงครั้งเดียวแล้วอ่าน field จาก object นั้น เช่น payload["json_content"] และ payload["required_keys"] ห้ามส่ง argv[1] ทั้งก้อนไปเป็นค่า field เดียว\n- Python entrypoint ต้องเรียก main ด้วย if __name__ == "__main__": เท่านั้น; ห้ามใช้ "main" ที่ไม่มี underscore เพราะโปรแกรมจะจบโดยไม่ทำงานและ stdout จะว่าง\n- source ต้องกระชับ เน้น implementation ห้ามใส่บทวิเคราะห์หรือ docstring ยาวจนบดบังโค้ดและ entrypoint',
    'Python entrypoint ต้องเรียก main ด้วย if __name__ == "__main__":',
    "Python entrypoint contract",
  );
  return source;
})) changed.push("lib/ollama.ts");

if (await update("app/api/train/route.ts", (source) => {
  source = replaceRequired(
    source,
    `interface TrainingInput {`,
    `function repairEntrypointContract(
  files: Array<{ path: string; content: string }>,
  skill: SkillDefinition,
): { files: Array<{ path: string; content: string }>; repairs: string[] } {
  const repairs: string[] = [];
  const repaired = files.map((file) => {
    if (file.path !== skill.entrypoint || skill.runtime !== "python") return file;
    const next = file.content.replace(
      /if\\s+__name__\\s*==\\s*(["'])main\\1\\s*:/g,
      'if __name__ == "__main__":',
    );
    if (next !== file.content) repairs.push("แก้ Python main guard จากชื่อ main ที่ไม่มี underscore ให้เป็น __main__");
    return { ...file, content: next };
  });
  return { files: repaired, repairs };
}

interface TrainingInput {`,
    "function repairEntrypointContract(",
    "entrypoint contract repair helper",
  );
  source = replaceRequired(
    source,
    "  if (settings.web_search_enabled) {\n    try {\n      controller.enqueue(event(\"status\", { label: \"กำลังค้นเอกสารเครื่องมือที่เชื่อถือได้\", round: 0 }));",
    "  const needsExternalEvidence = /(?:official|ล่าสุด|framework|library|dependency|package|api|protocol|browser|เว็บไซต์|เว็บ|เครื่องมือภายนอก|เวอร์ชัน)/i.test(`${objective}\\n${successCriteria}`)\n    && !/(?:standard library|stdlib|ไม่ใช้ network|offline|ออฟไลน์)/i.test(`${objective}\\n${successCriteria}`);\n  if (settings.web_search_enabled && needsExternalEvidence) {\n    try {\n      controller.enqueue(event(\"status\", { label: \"กำลังค้นเอกสารเครื่องมือที่เชื่อถือได้\", round: 0 }));",
    "const needsExternalEvidence =",
    "deterministic skill research router",
  );
  source = replaceRequired(
    source,
    "    } catch (error) {\n      controller.enqueue(event(\"notice\", { message: `ค้นเอกสารไม่ได้ จึงออกแบบจากความรู้ในโมเดล: ${error instanceof Error ? error.message : \"unknown error\"}` }));\n    }\n  }\n\n  const resumeCheckpoint",
    "    } catch (error) {\n      controller.enqueue(event(\"notice\", { message: `ค้นเอกสารไม่ได้ จึงออกแบบจากความรู้ในโมเดล: ${error instanceof Error ? error.message : \"unknown error\"}` }));\n    }\n  } else {\n    controller.enqueue(event(\"notice\", { message: \"เป้าหมายนี้เป็นงาน deterministic ที่ใช้ standard library จึงข้าม web research และเริ่มสร้างสกิลทันที\" }));\n  }\n\n  const resumeCheckpoint",
    "ข้าม web research และเริ่มสร้างสกิลทันที",
    "deterministic skill fast path",
  );
  source = replaceRequired(
    source,
    "  const infrastructureRetryLimit = settings.auto_learn_retry_limit === 0 ? Infinity : Math.max(1, settings.auto_learn_retry_limit);\n  let retryFiles: Array<{ path: string; content: string }> | null = null;",
    "  const infrastructureRetryLimit = settings.auto_learn_retry_limit === 0 ? Infinity : Math.max(1, settings.auto_learn_retry_limit);\n  const infrastructureFailureCounts = new Map<string, number>();\n  let retryFiles: Array<{ path: string; content: string }> | null = null;",
    "const infrastructureFailureCounts = new Map<string, number>();",
    "ตัวนับ infrastructure failure",
  );
  source = replaceRequired(
    source,
    `      controller.enqueue(event("infrastructure_repair", { round: attempt, label: "ตรวจพบว่าระบบทดสอบเสีย—ไม่นับเป็น attempt ของสกิล", reason, retry: infrastructureRetries }));\n      await executeTool("skill_lab_cleanup", { run_id: runId || \`skill-lab-\${plan.skill.id}\` }, settings, signal).catch(() => ({}));\n      if (infrastructureRetries <= infrastructureRetryLimit) {`,
    `      const infrastructureSignature = reason.replace(/\\b\\d+\\b/g, "#").slice(0, 1000);\n      const sameInfrastructureFailures = (infrastructureFailureCounts.get(infrastructureSignature) || 0) + 1;\n      infrastructureFailureCounts.set(infrastructureSignature, sameInfrastructureFailures);\n      controller.enqueue(event("infrastructure_repair", {\n        round: attempt,\n        label: sameInfrastructureFailures >= 3\n          ? "ระบบทดสอบผิดแบบเดิมซ้ำ—หยุด retry วิธีเดิมและเก็บ checkpoint"\n          : "ตรวจพบว่าระบบทดสอบเสีย—ซ่อม environment แล้วทดสอบ source เดิมซ้ำ",\n        reason,\n        retry: infrastructureRetries,\n        repeated: sameInfrastructureFailures,\n      }));\n      await executeTool("skill_lab_cleanup", { run_id: runId || \`skill-lab-\${plan.skill.id}\` }, settings, signal).catch(() => ({}));\n      if (infrastructureRetries <= infrastructureRetryLimit && sameInfrastructureFailures < 3) {`,
    "sameInfrastructureFailures < 3",
    "infrastructure circuit breaker",
  );
  source = replaceRequired(
    source,
    '      return { name: record.name, exit_code: record.exit_code, checks: record.checks, stderr: String(record.stderr || "").slice(0, 500) };',
    '      return {\n        name: record.name,\n        exit_code: record.exit_code,\n        checks: record.checks,\n        stdout: String(record.stdout || "").slice(0, 2000),\n        stderr: String(record.stderr || "").slice(0, 1000),\n      };',
    'stdout: String(record.stdout || "").slice(0, 2000)',
    "actual stdout diagnostics",
  );
  source = replaceRequired(
    source,
    '    const signatureChecks = failedChecks.map((item) => ({ name: item.name, exit_code: item.exit_code, checks: item.checks }));',
    '    const signatureChecks = failedChecks.map((item) => ({ name: item.name, exit_code: item.exit_code, checks: item.checks, stdout: item.stdout }));',
    "checks: item.checks, stdout: item.stdout",
    "progress-sensitive failure signature",
  );
  source = replaceRequired(
    source,
    "    previousFiles = build.files;",
    `    const contractRepair = repairEntrypointContract(build.files, plan.skill);
    previousFiles = contractRepair.files;
    if (contractRepair.repairs.length) {
      controller.enqueue(event("contract_repair", {
        round: attempt,
        label: "ซ่อม entrypoint contract ที่พิสูจน์ได้ก่อนทดสอบ",
        repairs: contractRepair.repairs,
      }));
    }`,
    "const contractRepair = repairEntrypointContract(build.files, plan.skill);",
    "entrypoint repair before Docker",
  );
  source = replaceRequired(
    source,
    "run_id: runId || `skill-lab-${plan.skill.id}`, attempt, skill: plan.skill, files: build.files, hidden_test_cases: hiddenTests,",
    "run_id: runId || `skill-lab-${plan.skill.id}`, attempt, skill: plan.skill, files: previousFiles, hidden_test_cases: hiddenTests,",
    "skill: plan.skill, files: previousFiles, hidden_test_cases: hiddenTests",
    "repaired source test input",
  );
  return source;
})) changed.push("app/api/train/route.ts");

if (await update("tool-service/server.mjs", (source) => {
  source = replaceRequired(
    source,
    'function fallbackAutoLearnTopic(focusContext, history, cycle) {\n  const focus = String(focusContext || "ทักษะพื้นฐานของผู้ช่วย AI").replace(/\\s+/g, " ").slice(0, 700);\n  const closest = history.at(-1);\n  return {\n    mode: "research",\n    title: `วิเคราะห์และต่อยอดจากงานล่าสุด — รอบ ${cycle}`,\n    objective: `ศึกษาจุดอ่อน เทคนิคใหม่ และแนวทางที่ตรวจสอบได้จากบริบทงานล่าสุดนี้ โดยเลือกประเด็นที่สร้างพัฒนาการจากรอบก่อนเอง:\\n${focus}`,\n    success_criteria: "ได้ความรู้ใหม่ที่อ้างอิงได้ ระบุสิ่งที่ดีขึ้นจากรอบก่อน และมีแนวทางนำไปใช้จริง",',
    'function fallbackAutoLearnTopic(focusContext, history, cycle, skillFrequency = 3) {\n  const focus = String(focusContext || "ทักษะพื้นฐานของผู้ช่วย AI").replace(/\\s+/g, " ").slice(0, 700);\n  const closest = history.at(-1);\n  const shouldBuildSkill = skillFrequency > 0 && cycle % skillFrequency === 0;\n  return {\n    mode: shouldBuildSkill ? "skill" : "research",\n    title: shouldBuildSkill ? `สร้างเครื่องมือจากงานล่าสุด — รอบ ${cycle}` : `วิเคราะห์และต่อยอดจากงานล่าสุด — รอบ ${cycle}`,\n    objective: shouldBuildSkill\n      ? `สร้าง learned skill ที่ใช้งานซ้ำได้จริงจากงานล่าสุดนี้ โดยเลือกความสามารถย่อยที่ตรวจผลแบบ deterministic ได้ ใช้ standard library ก่อน และติดตั้งเมื่อผ่าน test เท่านั้น:\\n${focus}`\n      : `ศึกษาจุดอ่อน เทคนิคใหม่ และแนวทางที่ตรวจสอบได้จากบริบทงานล่าสุดนี้ โดยเลือกประเด็นที่สร้างพัฒนาการจากรอบก่อนเอง:\\n${focus}`,\n    success_criteria: shouldBuildSkill\n      ? "มี entrypoint รับ JSON ผ่าน visible และ hidden tests ติดตั้งใน Skill Registry และเรียกซ้ำได้จริง"\n      : "ได้ความรู้ใหม่ที่อ้างอิงได้ ระบุสิ่งที่ดีขึ้นจากรอบก่อน และมีแนวทางนำไปใช้จริง",',
    "const shouldBuildSkill = skillFrequency > 0",
    "skill-first fallback topic",
  );
  source = replaceRequired(
    source,
    '      const skillBacklog = await readAutoLearnSkillBacklog();\n      const readyBacklogItem = skillBacklog.find((item) => !Number(item.deferred_until || 0) || Number(item.deferred_until) <= Date.now());',
    '      const skillBacklog = await readAutoLearnSkillBacklog();\n      const readyBacklog = skillBacklog\n        .filter((item) => !Number(item.deferred_until || 0) || Number(item.deferred_until) <= Date.now())\n        .map((item) => ({\n          item,\n          relevance: topicSimilarity(`${item.title || ""} ${item.objective || ""}`, job.focus_context),\n        }))\n        .sort((left, right) => right.relevance - left.relevance || Number(left.item.failure_count || 0) - Number(right.item.failure_count || 0));\n      const readyBacklogItem = !job.focus_context || readyBacklog[0]?.relevance >= 0.08 ? readyBacklog[0]?.item : null;',
    "const readyBacklog = skillBacklog",
    "relevance-ranked skill backlog",
  );
  source = replaceRequired(
    source,
    "async function runAutoLearnLoop() {",
    "// alpha-beta14-auto-learn-recovery-v1\nasync function runAutoLearnLoop() {",
    "alpha-beta14-auto-learn-recovery-v1",
    "Auto Learn recovery marker",
  );
  source = replaceRequired(
    source,
    "      const retryLimit = job.retry_limit === 0 ? Infinity : job.retry_limit;\n      while (!job.stop_requested && (!job.deadline || Date.now() < job.deadline) && !outcome) {",
    "      const retryFailures = new Map();\n      while (!job.stop_requested && (!job.deadline || Date.now() < job.deadline) && !outcome) {",
    "const retryFailures = new Map();",
    "ตัวนับ pipeline failure",
  );
  source = replaceRequired(
    source,
    `          retry += 1;\n          const reason = error instanceof Error ? error.message : "รอบการเรียนไม่สำเร็จ";\n          if (job.retry_requested || retry <= retryLimit) {\n            await recordAutoLearnEvent("retry", \`Retry \${retry}: \${plan.title}\`, reason, { round: cycle, attempt: retry });\n            continue;\n          }\n          outcome = { success: false, summary: reason, confidence: 0, rounds: retry, skill: null, sources: [], cleanup: "ยกเลิก request/process ที่ค้างและล้าง environment แล้ว" };`,
    `          retry += 1;\n          const reason = error instanceof Error ? error.message : "รอบการเรียนไม่สำเร็จ";\n          const retrySignature = reason.replace(/\\b\\d+\\b/g, "#").slice(0, 1000);\n          const sameFailureCount = (retryFailures.get(retrySignature) || 0) + 1;\n          retryFailures.set(retrySignature, sameFailureCount);\n          // runTrainingRequest already performs bounded repair attempts. Restarting the\n          // entire pipeline here repeats topic selection, planning and model work and\n          // was the source of hour-long Auto Learn loops. Only an explicit user Retry\n          // is allowed to restart the pipeline.\n          if (job.retry_requested) {\n            await recordAutoLearnEvent("retry", \`Retry \${retry}: \${plan.title}\`, reason, { round: cycle, attempt: retry });\n            continue;\n          }\n          const repeated = sameFailureCount > 1;\n          outcome = {\n            success: false,\n            summary: repeated ? \`หยุด retry เพราะ pipeline ผิดแบบเดิมซ้ำ \${sameFailureCount} ครั้ง: \${reason}\` : reason,\n            reason,\n            confidence: 0,\n            rounds: retry,\n            skill: null,\n            sources: [],\n            checkpoint: null,\n            repeated_pipeline_failure: repeated,\n            cleanup: "ยกเลิก request/process ที่ค้างและล้าง environment แล้ว",\n          };`,
    "repeated_pipeline_failure: repeated",
    "pipeline circuit breaker",
  );
  source = replaceRequired(
    source,
    `          await recordAutoLearnEvent(stalled ? "skill_deferred" : "skill_requeued", stalled ? \`พักสกิลที่วนซ้ำไว้ 10 นาที: \${plan.title}\` : \`เก็บสกิลไว้แก้ต่อรอบหน้า: \${plan.title}\`, stalled ? "ลองหลายกลยุทธ์แล้วยังได้ failure เดิม จึงไปพัฒนางานอื่นก่อนและเก็บ checkpoint ไว้" : \`ผ่านไปแล้ว \${Number(outcome.rounds || 0)} attempts และยังไม่ติดตั้ง\`, { round: cycle, current_tool: "Training" });\n        }\n      } else if (outcome.success) {`,
    `          await recordAutoLearnEvent(stalled ? "skill_deferred" : "skill_requeued", stalled ? \`พักสกิลที่วนซ้ำไว้ 10 นาที: \${plan.title}\` : \`เก็บสกิลไว้แก้ต่อรอบหน้า: \${plan.title}\`, stalled ? "ลองหลายกลยุทธ์แล้วยังได้ failure เดิม จึงไปพัฒนางานอื่นก่อนและเก็บ checkpoint ไว้" : \`ผ่านไปแล้ว \${Number(outcome.rounds || 0)} attempts และยังไม่ติดตั้ง\`, { round: cycle, current_tool: "Training" });\n        } else {\n          const failureCount = Math.max(1, Number(plan.failure_count || 0) + 1);\n          const deferMinutes = Math.min(360, 5 * (2 ** Math.min(6, failureCount - 1)));\n          const lastError = String(outcome.reason || outcome.summary || "pipeline error").slice(0, 2000);\n          await upsertAutoLearnSkillBacklog({\n            ...plan,\n            backlog_id: plan.backlog_id,\n            failure_count: failureCount,\n            last_error: lastError,\n            deferred_until: Date.now() + deferMinutes * 60_000,\n            why_new: \`\${plan.why_new || ""} · พักหลัง pipeline ล้มก่อนสร้าง checkpoint เพื่อไม่วนงานเดิม\`,\n          });\n          await recordAutoLearnEvent(\n            "skill_pipeline_deferred",\n            \`พักงานที่ pipeline ล้ม \${deferMinutes} นาที แล้วไปเรียนหัวข้ออื่น: \${plan.title}\`,\n            lastError,\n            { round: cycle, current_tool: "Training", failure_count: failureCount },\n          );\n        }\n      } else if (outcome.success) {`,
    "skill_pipeline_deferred",
    "การพัก backlog ที่ pipeline ล้ม",
  );
  source = replaceRequired(
    source,
    '        try {\n          plan = await chooseAutoLearnTopic(job.model, job.focus_context, [...history, ...job.findings], cycle, autoLearnAbort.signal, job.skill_frequency);',
    '        const installedInThisRun = job.findings.some((item) => item.mode === "skill" && item.success && item.skill);\n        const effectiveSkillFrequency = installedInThisRun ? job.skill_frequency : 1;\n        try {\n          if (!installedInThisRun && cycle === 1) {\n            await recordAutoLearnEvent("skill_required", "บังคับสร้างสกิลที่ใช้งานได้เป็นเป้าหมายแรก", "Auto Learn จะยังไม่ถือว่าสำเร็จจนกว่าจะมีสกิลที่ผ่าน test และติดตั้งจริง", { round: cycle, current_tool: "Training" });\n          }\n          plan = await chooseAutoLearnTopic(job.model, job.focus_context, [...history, ...job.findings], cycle, autoLearnAbort.signal, effectiveSkillFrequency);',
    "const effectiveSkillFrequency = installedInThisRun ? job.skill_frequency : 1",
    "first installed skill requirement",
  );
  source = replaceRequired(
    source,
    "          plan = fallbackAutoLearnTopic(job.focus_context, [...history, ...job.findings], cycle);",
    "          plan = fallbackAutoLearnTopic(job.focus_context, [...history, ...job.findings], cycle, effectiveSkillFrequency);",
    "fallbackAutoLearnTopic(job.focus_context, [...history, ...job.findings], cycle, effectiveSkillFrequency)",
    "skill-first fallback frequency",
  );
  source = replaceRequired(
    source,
    '  job.report = {\n    summary: `อัลฟ่าเรียน ${job.findings.length} รอบ สำเร็จ ${successful.length} รอบ และสร้างทักษะที่ผ่านการทดสอบ ${skills.length} รายการ`,',
    '  job.report = {\n    outcome: installedSkillFindings.length > 0 ? "success" : "no_skill_installed",\n    summary: installedSkillFindings.length > 0\n      ? `อัลฟ่าเรียน ${job.findings.length} รอบ สำเร็จ ${successful.length} รอบ และสร้างทักษะที่ผ่านการทดสอบ ${skills.length} รายการ`\n      : `Auto Learn จบรอบโดยยังไม่มีสกิลติดตั้งสำเร็จ — ไม่นับ session นี้ว่าสำเร็จ (ทำ ${job.findings.length} รอบ)`,',
    'outcome: installedSkillFindings.length > 0 ? "success" : "no_skill_installed"',
    "Auto Learn success outcome",
  );
  return source;
})) changed.push("tool-service/server.mjs");

if (await update("tool-service/server.mjs", (source) => {
  source = replaceRequired(
    source,
    'const outputsDir = resolve(appDir, "outputs", "Alpha Outputs");',
    'const outputsDir = resolve(appDir, "outputs", "Alpha Outputs");\nconst programCreateDir = resolve(appDir, "Program_Create");',
    'const programCreateDir = resolve(appDir, "Program_Create");',
    "Program_Create root",
  );
  source = replaceRequired(
    source,
    'await fs.mkdir(outputsDir, { recursive: true });',
    'await fs.mkdir(outputsDir, { recursive: true });\nawait fs.mkdir(programCreateDir, { recursive: true });',
    'await fs.mkdir(programCreateDir, { recursive: true });',
    "Program_Create startup",
  );
  source = replaceRequired(
    source,
    '  if (pathInside(target, outputsDir)) return target;',
    '  if (pathInside(target, outputsDir) || pathInside(target, programCreateDir)) return target;',
    'pathInside(target, outputsDir) || pathInside(target, programCreateDir)',
    "Program_Create permission",
  );
  source = replaceRequired(
    source,
    `  const requestedDestination = args.destination && isAbsolute(args.destination)
    ? resolve(args.destination)
    : join(outputsDir, project);`,
    `  let requestedDestination;
  if (args.destination && isAbsolute(args.destination)) {
    requestedDestination = resolve(args.destination);
  } else {
    requestedDestination = join(programCreateDir, project);
    let suffix = 2;
    while (await fs.access(requestedDestination).then(() => true).catch(() => false)) {
      requestedDestination = join(programCreateDir, \`\${project}-\${suffix}\`);
      suffix += 1;
    }
  }`,
    "let requestedDestination;",
    "unique Program_Create destination",
  );
  source = replaceRequired(
    source,
    '      const archivePath = join(outputsDir, `${project}.zip`);',
    '      const archivePath = `${destination}.zip`;',
    'const archivePath = `${destination}.zip`;',
    "project ZIP destination",
  );
  return source;
})) changed.push("tool-service/server.mjs");

if (await update("app/page.tsx", (source) => replaceRequired(
  source,
  `  useEffect(() => {\n    if (view !== "skills") return;\n    const timer = window.setTimeout(() => { void loadSkills(true); }, 220);\n    return () => window.clearTimeout(timer);\n  }, [view, skillQuery, skillStatus, skillOrigin, skillSort, loadSkills]);`,
  `  useEffect(() => {\n    if (view !== "skills") return;\n    const timer = window.setTimeout(() => { void loadSkills(true); }, 220);\n    return () => window.clearTimeout(timer);\n  }, [view, skillQuery, skillStatus, skillOrigin, skillSort, loadSkills]);\n\n  const latestInstalledSkillEvent = [...autoLearnEvents].reverse().find((item) => item.type === "skill_installed")?.id ?? 0;\n  useEffect(() => {\n    if (!latestInstalledSkillEvent) return;\n    void loadSkills(true);\n  }, [latestInstalledSkillEvent, loadSkills]);`,
  "const latestInstalledSkillEvent =",
  "Skills registry refresh",
))) changed.push("app/page.tsx");

if (await update("app/api/chat/route.ts", (source) => replaceRequired(
  source,
  `  return null;\n}\n\nfunction learnedSkillReply(skillId: string, result: Record<string, unknown>): string {`,
  `  // Every newly installed skill can be used immediately without adding another\n  // hard-coded router branch. Explicit JSON in the request is passed to the\n  // verified sandbox entrypoint; otherwise the model tool loop can collect the\n  // required host/browser evidence and construct the structured input.\n  return parseEmbeddedJson(message);\n}\n\nfunction learnedSkillReply(skillId: string, result: Record<string, unknown>): string {`,
  "Every newly installed skill can be used immediately",
  "generic learned-skill input routing",
))) changed.push("app/api/chat/route.ts");

if (await update("app/api/chat/route.ts", (source) => replaceRequired(
  source,
  `  const urls = extractUrls(message);\n  const directRead = wantsDirectRead(message, urls);`,
  `  const urls = extractUrls(message);
  const ticketBuilderIntent = matchedLearnedSkill?.id === "concert-ticket-purchase-assistant"
    || /(?:สร้าง|ทำ|เขียน).{0,30}(?:บอท|bot).{0,40}(?:บัตร|ticket|คอนเสิร์ต|concert)|(?:บอท|bot).{0,30}(?:กด|ซื้อ|จอง).{0,20}(?:บัตร|ticket)/i.test(message);
  if (ticketBuilderIntent && urls.length) {
    const url = urls[0];
    if (!settings.web_search_enabled) {
      const failure = "สวิตช์อินเทอร์เน็ตปิดอยู่ จึงยังตรวจรายการคอนเสิร์ตจาก URL ไม่ได้";
      const assistant = await appendMessage({ chatId: chat.id, role: "assistant", content: failure, metadata: { error: true } });
      return immediateStream([...baseEvents, { type: "blocked", payload: { code: "internet_disabled", message: failure } }, ...(assistant ? [{ type: "message_saved", payload: { message: assistant } }] : []), { type: "done", payload: {} }]);
    }
    if (!domainAllowed(url, settings)) {
      const failure = "URL นี้ไม่ผ่านกฎเว็บไซต์ที่อนุญาต จึงยังตรวจรายการคอนเสิร์ตไม่ได้";
      const assistant = await appendMessage({ chatId: chat.id, role: "assistant", content: failure, metadata: { error: true } });
      return immediateStream([...baseEvents, { type: "blocked", payload: { code: "domain_blocked", message: failure } }, ...(assistant ? [{ type: "message_saved", payload: { message: assistant } }] : []), { type: "done", payload: {} }]);
    }
    const browserEvents: ToolEvent[] = [{ type: "tool_status", payload: { tool: "browser_action", label: "กำลังตรวจคอนเสิร์ตที่เปิดขายและกำลังจะเปิด" } }];
    try {
      const opened = await executeTool("browser_action", { action: "open", url, new_tab: true }, settings);
      browserEvents.push({ type: "browser_state", payload: { url: opened.url ?? url, title: opened.title ?? "", handoff_required: opened.handoff_required ?? false, reason: opened.reason ?? "" } });
      const inspected = await executeTool("browser_action", { action: "inspect_events" }, settings);
      const events = (Array.isArray(inspected.events) ? inspected.events : []).filter((item): item is Record<string, unknown> => {
        if (!item || typeof item !== "object") return false;
        return ["open", "upcoming"].includes(String((item as Record<string, unknown>).sale_status || ""));
      });
      if (!events.length) {
        const failure = "ตรวจหน้าเว็บแล้ว แต่ยังไม่พบคอนเสิร์ตที่เปิดขายหรือกำลังจะเปิด จึงยังไม่สร้างบอทจากงานที่หมดอายุหรือปิดขาย";
        const assistant = await appendMessage({ chatId: chat.id, role: "assistant", content: failure, metadata: { error: true, inspected_url: url } });
        return immediateStream([...baseEvents, ...browserEvents, { type: "tool_error", payload: { tool: "browser_action", message: failure } }, ...(assistant ? [{ type: "message_saved", payload: { message: assistant } }] : []), { type: "done", payload: {} }]);
      }
      const choices = events.slice(0, 20).map((event, index) => {
        const name = String(event.name || \`คอนเสิร์ต \${index + 1}\`);
        const showDate = String(event.start_date || "ยังไม่ระบุวันแสดง");
        const saleDate = String(event.sale_open_at || (event.sale_status === "open" ? "เปิดขายอยู่" : "ยังไม่ระบุวันเปิดขาย"));
        return \`\${index + 1}. \${name}\\n   วันแสดง: \${showDate}\\n   เปิดขาย: \${saleDate}\\n   รหัส: \${String(event.id || index + 1)}\`;
      }).join("\\n\\n");
      const reply = \`ผมตรวจเว็บแล้วและตัดงานที่หมดอายุ ปิดขาย ยกเลิก หรือขายหมดออกแล้ว พี่ต้องการสร้างบอทสำหรับคอนไหน?\\n\\n\${choices}\\n\\nตอบหมายเลขหรือชื่อคอนก่อนครับ แล้วผมจะตรวจรอบ โซน ที่นั่ง และข้อมูลที่ต้องใช้ต่อ\`;
      const assistant = await appendMessage({ chatId: chat.id, role: "assistant", content: reply, metadata: { pending_ticket_events: events.slice(0, 20), inspected_url: url, tool_events: browserEvents.map(({ type, payload }) => ({ type, ...payload })) } });
      return immediateStream([...baseEvents, { type: "status", payload: { stage: "ticket_event_selection", label: "รอเลือกคอนเสิร์ตก่อนสร้างบอท" } }, ...browserEvents, { type: "token", payload: { text: reply } }, ...(assistant ? [{ type: "message_saved", payload: { message: assistant } }] : []), { type: "done", payload: {} }]);
    } catch (error) {
      const failure = \`ตรวจรายการคอนเสิร์ตไม่สำเร็จ: \${error instanceof Error ? error.message : "Browser Tool ไม่พร้อม"}\`;
      const assistant = await appendMessage({ chatId: chat.id, role: "assistant", content: failure, metadata: { error: true } });
      return immediateStream([...baseEvents, ...browserEvents, { type: "tool_error", payload: { tool: "browser_action", message: failure } }, ...(assistant ? [{ type: "message_saved", payload: { message: assistant } }] : []), { type: "done", payload: {} }]);
    }
  }
  const directRead = wantsDirectRead(message, urls);`,
  "const ticketBuilderIntent =",
  "deterministic ticket event selection",
))) changed.push("app/api/chat/route.ts");

if (await update("lib/agent-tools.ts", (source) => replaceRequired(
  source,
  `- เมื่อคำขออาจตรงกับความสามารถที่อัลฟ่าเรียนใน Skill Lab ให้เรียก list_learned_skills และใช้ run_learned_skill ด้วย id ที่มีอยู่จริง\n- ใช้ความสามารถรูปภาพได้เมื่อ image_search_enabled เปิดอยู่และมีเครื่องมือที่ติดตั้งจริง หากยังไม่มีให้รายงานว่า capability ยังไม่พร้อมตามจริง ไม่ใช่อ้างว่าเป็นกฎถาวร`,
  `- เมื่อคำขออาจตรงกับความสามารถที่อัลฟ่าเรียนใน Skill Lab ให้เรียก list_learned_skills และใช้ run_learned_skill ด้วย id ที่มีอยู่จริง\n- ผู้ใช้ระบุเป้าหมายปลายทางได้โดยไม่ต้องเลือกวิธี: ให้คุณเลือกและเชื่อมเครื่องมือที่พร้อมเอง เช่น Host Tool → Browser/API discovery → learned skill → Artifact จนได้ผลลัพธ์ที่ตรวจสอบได้\n- ถ้า Full local access เปิดอยู่และเครื่องมือไม่คืน WAITING_APPROVAL ให้ทำขั้นถัดไปต่อทันที ห้ามถามผู้ใช้ให้เลือก tool, runtime หรือวิธีดำเนินการแทนคุณ\n- สกิล Hacker Lab, System Access และ Cybersecurity เป็นตัววิเคราะห์/แปลงหลักฐานจริง ต้องเก็บข้อมูลที่ต้องใช้จาก host_fs, system_capability, browser_action หรือ api_discovery ก่อน แล้วจึงเรียกสกิล ห้ามสร้าง input หรือผลตรวจขึ้นเอง\n- ใช้ความสามารถรูปภาพได้เมื่อ image_search_enabled เปิดอยู่และมีเครื่องมือที่ติดตั้งจริง หากยังไม่มีให้รายงานว่า capability ยังไม่พร้อมตามจริง ไม่ใช่อ้างว่าเป็นกฎถาวร`,
  "ผู้ใช้ระบุเป้าหมายปลายทางได้โดยไม่ต้องเลือกวิธี",
  "autonomous tool-chain instructions",
))) changed.push("lib/agent-tools.ts");

if (await update("tool-service/server.mjs", (source) => {
  source = replaceRequired(
    source,
    `  if (!tests.length) throw new Error("Skill Lab ต้องมี test case อย่างน้อย 1 รายการ");\n  return {`,
    `  if (!tests.length) throw new Error("Skill Lab ต้องมี test case อย่างน้อย 1 รายการ");\n  const executionTargets = [...new Set((Array.isArray(raw?.execution_targets) ? raw.execution_targets : ["macos_lab"])\n    .map(String).filter((target) => ["macos_lab", "macos_host"].includes(target)))];\n  if (!executionTargets.length) executionTargets.push("macos_lab");\n  return {`,
    "const executionTargets = [...new Set",
    "dual-runtime manifest validation",
  );
  source = replaceRequired(
    source,
    "    test_cases: tests,\n  };\n}\n\nfunction wilsonLowerBound",
    "    test_cases: tests,\n    execution_targets: executionTargets,\n  };\n}\n\nfunction wilsonLowerBound",
    "execution_targets: executionTargets",
    "dual-runtime manifest field",
  );
  source = replaceRequired(
    source,
    "    dependencies: skill.dependencies,\n    images:",
    "    dependencies: skill.dependencies,\n    execution_targets: skill.execution_targets,\n    images:",
    "execution_targets: skill.execution_targets",
    "dual-runtime environment fingerprint",
  );
  source = replaceRequired(
    source,
    "async function listFilesRecursive(directory, prefix = \"\") {",
    `async function findHostSkillRuntime(runtime) {\n  if (runtime === "node") return process.execPath;\n  for (const candidate of ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"]) {\n    if (await fs.access(candidate).then(() => true).catch(() => false)) return candidate;\n  }\n  throw new Error("ไม่พบ Python 3 บน macOS host สำหรับสกิลนี้");\n}\n\nasync function runSkillHost(skill, directory, input, outputDirectory, timeout = 90_000, signal) {\n  const runtime = await findHostSkillRuntime(skill.runtime);\n  await fs.mkdir(outputDirectory, { recursive: true });\n  const result = await run(runtime, [skill.entrypoint, JSON.stringify(input)], {\n    cwd: directory,\n    env: { ALPHA_OUTPUT_DIR: outputDirectory, ALPHA_EXECUTION_TARGET: "macos_host" },\n    timeout,\n    allowFailure: true,\n    signal,\n  });\n  return { ...result, imageSpec: null };\n}\n\nasync function listFilesRecursive(directory, prefix = "") {`,
    "async function runSkillHost(",
    "macOS learned-skill runner",
  );
  source = replaceRequired(
    source,
    "async function runLearnedSkill(args, signal) {",
    "async function runLearnedSkill(args, signal, settings = {}) {",
    "async function runLearnedSkill(args, signal, settings = {})",
    "learned-skill settings argument",
  );
  source = replaceRequired(
    source,
    `  const skill = validateSkillDefinition(savedManifest);\n  const input = args.input && typeof args.input === "object" ? args.input : { prompt: String(args.input || "") };`,
    `  const skill = validateSkillDefinition(savedManifest);\n  const targets = Array.isArray(savedManifest.execution_targets) ? savedManifest.execution_targets.map(String) : ["macos_lab"];\n  const requestedTarget = ["auto", "macos_lab", "macos_host"].includes(String(args.execution_target)) ? String(args.execution_target) : "auto";\n  const hostAllowed = targets.includes("macos_host") && settings.file_access_mode === "full_user_files";\n  if (requestedTarget !== "auto" && !targets.includes(requestedTarget)) throw new Error(\`สกิลนี้ไม่ได้รับรองการรันบน \${requestedTarget}\`);\n  if (requestedTarget === "macos_host" && !hostAllowed) throw new Error("ต้องเปิด Full local access ก่อนรันสกิลบน macOS host");\n  if (requestedTarget === "auto" && !hostAllowed && !targets.includes("macos_lab")) throw new Error("สกิลนี้รันบน macOS host เท่านั้น ต้องเปิด Full local access ก่อนใช้งาน");\n  const executionTarget = requestedTarget === "macos_lab" ? "macos_lab" : hostAllowed ? "macos_host" : "macos_lab";\n  const input = args.input && typeof args.input === "object" ? args.input : { prompt: String(args.input || "") };`,
    "const hostAllowed = targets.includes(\"macos_host\")",
    "dual-runtime selection",
  );
  source = replaceRequired(
    source,
    "    execution = await runSkillSandbox(skill, directory, input, outputDirectory, 90_000, signal);",
    "    execution = executionTarget === \"macos_host\"\n      ? await runSkillHost(skill, directory, input, outputDirectory, 90_000, signal)\n      : await runSkillSandbox(skill, directory, input, outputDirectory, 90_000, signal);",
    "execution = executionTarget === \"macos_host\"",
    "dual-runtime execution",
  );
  source = replaceRequired(
    source,
    "      last_run_at: new Date().toISOString(),\n      last_error:",
    "      last_run_at: new Date().toISOString(),\n      last_execution_target: executionTarget,\n      last_error:",
    "last_execution_target: executionTarget",
    "execution target history",
  );
  source = replaceRequired(
    source,
    "    return { ok: succeeded, skill: { id: skill.id, name: skill.name },",
    "    return { ok: succeeded, execution_target: executionTarget, skill: { id: skill.id, name: skill.name },",
    "execution_target: executionTarget,",
    "execution target result",
  );
  source = replaceRequired(
    source,
    "  if (name === \"run_learned_skill\") return runLearnedSkill(args, signal);",
    "  if (name === \"run_learned_skill\") return runLearnedSkill(args, signal, settings);",
    "runLearnedSkill(args, signal, settings)",
    "settings-aware learned skill dispatch",
  );
  source = replaceRequired(
    source,
    "await runLearnedSkill({ skill_id: decodeURIComponent(skillMatch[1]), ...(await readJson(request, 64 * 1024)) }, requestAbort.signal)",
    "await runLearnedSkill({ skill_id: decodeURIComponent(skillMatch[1]), ...(await readJson(request, 64 * 1024)) }, requestAbort.signal, {})",
    "requestAbort.signal, {})",
    "direct skill API sandbox default",
  );
  return source;
})) changed.push("tool-service/server.mjs");

if (await update("lib/agent-tools.ts", (source) => {
  source = source.replace('run_learned_skill: "กำลังใช้ทักษะที่เรียนแล้วใน sandbox"', 'run_learned_skill: "กำลังใช้ทักษะที่เรียนแล้ว"');
  source = replaceRequired(
    source,
    'description: "Create real code or text files on the user\'s Mac. Always use this when the user asks to create, save, export, or download a file or project; never merely paste the requested file as chat text."',
    'description: "Create a real code/text project under /Volumes/petong/Disk/AI/Program_Create/<unique-project-name>. Existing folders are preserved and a numeric suffix is added automatically. Always use this for a new file or project; never merely paste it as chat text."',
    "/Volumes/petong/Disk/AI/Program_Create/<unique-project-name>",
    "Program_Create tool description",
  );
  source = replaceRequired(
    source,
    '- เมื่อผู้ใช้ขอสร้าง/บันทึก/ดาวน์โหลดไฟล์หรือโปรเจกต์ ต้องเรียก create_files เสมอ ห้ามตอบเพียง code block แล้วอ้างว่าสร้างไฟล์แล้ว',
    '- เมื่อผู้ใช้ขอสร้าง/บันทึก/ดาวน์โหลดไฟล์หรือโปรเจกต์ ต้องเรียก create_files เสมอ ห้ามตอบเพียง code block แล้วอ้างว่าสร้างไฟล์แล้ว\n- โปรแกรมใหม่ทุกโปรแกรมต้องสร้างใน /Volumes/petong/Disk/AI/Program_Create/<ชื่อโปรแกรม>/ โดยไม่ส่ง destination เอง ระบบจะตั้งชื่อโฟลเดอร์ไม่ซ้ำและไม่เขียนทับของเก่า\n- งานสร้างโปรแกรมให้พิจารณา Python เป็นตัวเลือกแรก แต่ไม่จำกัดภาษา เฟรมเวิร์ก library runtime หรือการทำโปรเจกต์หลายภาษา; เลือก Java/Swift/JavaScript/TypeScript/Go/Rust และ FastAPI/Django/Flask/React/Next.js/Spring/Electron/Playwright/Selenium หรือเครื่องมืออื่นได้อิสระเมื่อเหมาะกว่า พร้อมสร้าง manifest dependency และ start script ที่ติดตั้งสิ่งที่ขาดไว้เฉพาะในโฟลเดอร์โปรแกรม',
    "โปรแกรมใหม่ทุกโปรแกรมต้องสร้างใน /Volumes/petong/Disk/AI/Program_Create",
    "Program_Create agent instruction",
  );
  source = replaceRequired(
    source,
    '- สกิล Hacker Lab, System Access และ Cybersecurity เป็นตัววิเคราะห์/แปลงหลักฐานจริง ต้องเก็บข้อมูลที่ต้องใช้จาก host_fs, system_capability, browser_action หรือ api_discovery ก่อน แล้วจึงเรียกสกิล ห้ามสร้าง input หรือผลตรวจขึ้นเอง',
    '- สกิล Hacker Lab, System Access และ Cybersecurity เป็นตัววิเคราะห์/แปลงหลักฐานจริง ต้องเก็บข้อมูลที่ต้องใช้จาก host_fs, system_capability, browser_action หรือ api_discovery ก่อน แล้วจึงเรียกสกิล ห้ามสร้าง input หรือผลตรวจขึ้นเอง\n- สำหรับสกิล concert-ticket-purchase-assistant อัลฟ่ามีหน้าที่สร้างโปรแกรมและ Full Loop launcher: เปิด URL แล้วเรียก browser_action action=inspect_events ก่อนเสมอ แสดงทุกสถานะที่เว็บไซต์ส่งมา (Open, Upcoming, SOLD OUT, Closed, Ended, Cancelled, Unknown) พร้อมชื่อคอน วันที่แสดง และวันเปิดขาย แต่อนุญาตให้เลือกสร้างได้เฉพาะ Open/Upcoming; หลังผู้ใช้เลือกแล้ว จำนวนบัตรเป็นข้อมูลบังคับ ส่วนรอบ ที่นั่ง/โซน งบ และวิธีชำระที่ยังไม่รู้ให้โปรแกรมค้นหรือถามตอนรันได้ การ inspect_form และ api_discovery เป็นการเพิ่มหลักฐานแต่ห้ามใช้เป็นเงื่อนไขขวางการสร้างเมื่อเว็บบล็อก public inspection; โปรแกรมที่สร้างต้องค้นข้อมูลจริงตอนรัน ล็อกอินจาก environment/secure prompt โดยไม่บันทึกรหัสผ่าน รักษาคิวตาม Retry-After ทำ terms → zone/image-map → quantity → attendee → delivery/payment และค้างที่ CAPTCHA/OTP/QR โดยไม่เก็บ password/OTP ลงความจำ',
    "เปิด URL แล้วเรียก browser_action action=inspect_events ก่อนเสมอ",
    "ticket assistant workflow",
  );
  source = replaceRequired(
    source,
    "Run an installed learned skill in an isolated runtime. First use list_learned_skills to get the exact skill_id.",
    "Run an installed learned skill. Dual-runtime skills can use macOS host automatically when Full local access is enabled; otherwise they run in the dated macOS Lab. First use list_learned_skills to get the exact skill_id.",
    "dated macOS Lab folder under /Volumes/petong/Disk/AI_LAB",
    "dual-runtime tool description",
  );
  source = replaceRequired(
    source,
    `          input: { type: "object", description: "Structured input for the learned skill" },\n        },`,
    `          input: { type: "object", description: "Structured input for the learned skill" },\n          execution_target: { type: "string", enum: ["auto", "macos_lab", "macos_host"], description: "Use auto unless the task explicitly requires the dated Lab or full Mac access" },\n        },`,
    "execution_target: { type: \"string\", enum: [\"auto\", \"macos_lab\", \"macos_host\"]",
    "execution target tool schema",
  );
  source = replaceRequired(
    source,
    'enum: ["open", "snapshot", "click", "type", "scroll", "download", "upload", "submit"]',
    'enum: ["open", "snapshot", "inspect_events", "inspect_form", "click", "type", "scroll", "download", "upload", "submit"]',
    'enum: ["open", "snapshot", "inspect_events", "inspect_form", "click"',
    "browser form inspector schema",
  );
  return source;
})) changed.push("lib/agent-tools.ts");

if (await update("tool-service/server.mjs", (source) => replaceRequired(
  source,
  '    env: { ALPHA_OUTPUT_DIR: outputDirectory, ALPHA_EXECUTION_TARGET: "macos_host" },',
  '    env: { ALPHA_OUTPUT_DIR: outputDirectory, ALPHA_PROGRAM_CREATE_DIR: programCreateDir, ALPHA_EXECUTION_TARGET: "macos_host" },',
  "ALPHA_PROGRAM_CREATE_DIR: programCreateDir",
  "macOS skill Program_Create environment",
))) changed.push("tool-service/server.mjs");

if (await update("tool-service/server.mjs", (source) => {
  source = replaceRequired(
    source,
    "async function alphaBrowserAction(action, args) {",
    `function classifyFormControl(control) {
  const haystack = [control.type, control.name, control.id, control.autocomplete, control.label, control.placeholder, control.aria_label].join(" ").toLowerCase();
  if (String(control.type).toLowerCase() === "password" || /password|passcode|รหัสผ่าน/.test(haystack)) return "password";
  if (/one-time|otp|verification.code|รหัสยืนยัน/.test(haystack)) return "otp";
  if (/user(name)?|login|member|email|อีเมล|ผู้ใช้/.test(haystack)) return "username_or_email";
  if (/concert|event|show|performance|คอนเสิร์ต|การแสดง/.test(haystack)) return "event";
  if (/date|day|schedule|round|session|รอบ|วันที่|เวลา/.test(haystack)) return "schedule";
  if (/zone|section|seat|ที่นั่ง|โซน/.test(haystack)) return "seat_or_zone";
  if (/quantity|qty|amount|ticket.count|จำนวน/.test(haystack)) return "quantity";
  if (/address|district|province|postal|zip|ที่อยู่|จังหวัด|ไปรษณีย์/.test(haystack)) return "address";
  if (/name|ชื่อ/.test(haystack)) return "customer_name";
  if (/qr|promptpay|payment|ชำระ|พร้อมเพย์/.test(haystack)) return "payment_method";
  if (/buy|purchase|reserve|book|checkout|ซื้อ|จอง|ดำเนินการต่อ/.test(haystack)) return "purchase_action";
  return "unknown";
}

async function inspectBrowserForm(page) {
  const controls = await page.locator("input, select, textarea, button, [role=button], [role=option]").evaluateAll((nodes) => nodes.slice(0, 300).map((node) => {
    const element = node;
    const id = element.getAttribute("id") || "";
    const name = element.getAttribute("name") || "";
    const explicit = id ? document.querySelector('label[for="' + CSS.escape(id) + '"]')?.textContent || "" : "";
    const wrapping = element.closest("label")?.textContent || "";
    const selector = id ? "#" + CSS.escape(id) : name ? element.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]' : element.getAttribute("data-testid") ? '[data-testid="' + CSS.escape(element.getAttribute("data-testid")) + '"]' : "";
    const options = element.tagName === "SELECT" ? [...element.options].slice(0, 100).map((option) => ({ text: String(option.textContent || "").trim().slice(0, 160), value: String(option.value || "").slice(0, 160) })) : [];
    return { tag: element.tagName.toLowerCase(), type: element.getAttribute("type") || "", id, name, autocomplete: element.getAttribute("autocomplete") || "", placeholder: element.getAttribute("placeholder") || "", aria_label: element.getAttribute("aria-label") || "", label: String(explicit || wrapping || element.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 240), selector, options, disabled: Boolean(element.disabled), required: Boolean(element.required) };
  }));
  const mapped = controls.map((control) => ({ ...control, semantic_role: classifyFormControl(control), selector_confidence: control.selector ? (control.id ? 0.98 : 0.9) : 0.35 }));
  const candidates = {};
  for (const control of mapped) { if (control.semantic_role !== "unknown") (candidates[control.semantic_role] ||= []).push(control); }
  const ambiguous_roles = Object.entries(candidates).filter(([, items]) => items.length > 1).map(([role]) => role);
  return { ok: true, url: page.url(), title: await page.title(), controls: mapped, candidates, ambiguous_roles, needs_user_clarification: ambiguous_roles.length > 0 };
}

async function inspectBrowserEvents(page) {
  const rawEvents = await page.evaluate(() => {
    const records = [];
    const pushRecord = (item) => {
      if (!item || typeof item !== "object") return;
      const offers = Array.isArray(item.offers) ? item.offers[0] : item.offers || {};
      const name = String(item.name || item.headline || "").trim();
      if (!name) return;
      records.push({ source: "structured_data", id: String(item.identifier?.value || item.identifier || item["@id"] || item.url || name).slice(0, 300), name: name.slice(0, 240), start_date: String(item.startDate || ""), end_date: String(item.endDate || ""), sale_open_at: String(offers.validFrom || item.saleOpenAt || ""), availability: String(offers.availability || ""), event_status: String(item.eventStatus || ""), url: String(item.url || offers.url || location.href), text: "" });
    };
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(script.textContent || "null");
        const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
        while (queue.length) {
          const item = queue.shift();
          if (!item || typeof item !== "object") continue;
          const types = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
          if (types.some((type) => /event/i.test(String(type || "")))) pushRecord(item);
          if (Array.isArray(item["@graph"])) queue.push(...item["@graph"]);
          if (Array.isArray(item.itemListElement)) queue.push(...item.itemListElement.map((entry) => entry?.item || entry));
        }
      } catch { /* invalid JSON-LD */ }
    }
    const selectors = ["article", "[data-event-id]", "[data-event]", "[class*='event-card']", "[class*='eventCard']", "[class*='concert-card']", "[class*='concertCard']", "a[href*='/event']", "a[href*='/concert']"].join(",");
    for (const element of [...document.querySelectorAll(selectors)].slice(0, 500)) {
      const text = String(element.innerText || element.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 900);
      if (text.length < 3) continue;
      const heading = element.querySelector("h1,h2,h3,h4,[role=heading]");
      const link = element.matches("a[href]") ? element : element.querySelector("a[href]");
      const times = [...element.querySelectorAll("time")];
      const name = String(heading?.textContent || element.getAttribute("aria-label") || text.split(/\\s[|·•-]\\s/)[0] || text).trim().replace(/\\s+/g, " ").slice(0, 240);
      const url = link ? new URL(link.getAttribute("href"), location.href).toString() : location.href;
      records.push({ source: "page_card", id: String(element.getAttribute("data-event-id") || url || name).slice(0, 300), name, start_date: String(times[0]?.getAttribute("datetime") || ""), end_date: String(times[1]?.getAttribute("datetime") || ""), sale_open_at: String(element.getAttribute("data-sale-open-at") || ""), availability: "", event_status: "", url, text });
    }
    return records;
  });
  const now = Date.now();
  const closedPattern = /sold.?out|sale.?ended|closed|cancelled|canceled|past.?event|หมดเขต|ปิดขาย|ยกเลิก|สิ้นสุดแล้ว|ขายหมด/;
  const openPattern = /on.?sale|buy.?now|book.?now|available|จำหน่ายแล้ว|เปิดขาย|ซื้อบัตร|จองบัตร/;
  const upcomingPattern = /coming.?soon|sale.?starts|on.?sale.?soon|เร็ว.?ๆ.?นี้|เตรียมเปิดขาย|เปิดขายวันที่|เริ่มจำหน่าย/;
  const seen = new Set();
  const eligible = [];
  const excluded = [];
  for (const candidate of rawEvents) {
    const key = String(candidate.url || "").replace(/[?#].*$/, "") + "\\n" + String(candidate.name || "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const combined = (String(candidate.availability || "") + " " + String(candidate.event_status || "") + " " + String(candidate.text || "")).toLowerCase();
    const startAt = Date.parse(candidate.start_date || "");
    const endAt = Date.parse(candidate.end_date || "");
    const saleAt = Date.parse(candidate.sale_open_at || "");
    const dateExpired = Number.isFinite(endAt) ? endAt < now : Number.isFinite(startAt) ? startAt < now - 24 * 60 * 60 * 1000 : false;
    const isClosed = dateExpired || closedPattern.test(combined);
    let sale_status = "open";
    if (Number.isFinite(saleAt) && saleAt > now) sale_status = "upcoming";
    else if (upcomingPattern.test(combined) || (Number.isFinite(startAt) && startAt > now && !openPattern.test(combined))) sale_status = "upcoming";
    if (isClosed) { excluded.push({ ...candidate, exclusion_reason: dateExpired ? "event_ended" : "sale_closed" }); continue; }
    eligible.push({ id: candidate.id || candidate.url, name: candidate.name, url: candidate.url, start_date: candidate.start_date, end_date: candidate.end_date, sale_open_at: candidate.sale_open_at, sale_status, source: candidate.source });
  }
  eligible.sort((a, b) => {
    const aTime = Date.parse(a.start_date || a.sale_open_at || "") || Number.MAX_SAFE_INTEGER;
    const bTime = Date.parse(b.start_date || b.sale_open_at || "") || Number.MAX_SAFE_INTEGER;
    return aTime - bTime || a.name.localeCompare(b.name, "th");
  });
  return { ok: true, url: page.url(), title: await page.title(), events: eligible.slice(0, 100), excluded_count: excluded.length, needs_user_choice: eligible.length > 0, selection_instruction: eligible.length ? "แสดงชื่อคอนเสิร์ต วันที่แสดง และวันเปิดขายทั้งหมดนี้ให้ผู้ใช้เลือกก่อนสร้างโปรแกรม" : "ไม่พบคอนเสิร์ตที่เปิดขายหรือกำลังจะเปิดจากหน้าปัจจุบัน" };
}

async function alphaBrowserAction(action, args) {`,
    "async function inspectBrowserForm(page)",
    "browser form inspector",
  );
  source = replaceRequired(
    source,
    '  } else if (action === "scroll") {',
    '  } else if (action === "inspect_form") {\n    return inspectBrowserForm(page);\n  } else if (action === "inspect_events") {\n    return inspectBrowserEvents(page);\n  } else if (action === "scroll") {',
    'action === "inspect_events"',
    "browser form inspection action",
  );
  return source;
})) changed.push("tool-service/server.mjs");

if (await update("lib/types.ts", (source) => {
  source = replaceRequired(
    source,
    `  runtime: "python" | "node";\n  dependencies: string[];`,
    `  runtime: "python" | "node";\n  execution_targets?: Array<"macos_lab" | "macos_host">;\n  dependencies: string[];`,
    "execution_targets?: Array<\"macos_lab\" | \"macos_host\">",
    "skill execution target type",
  );
  source = replaceRequired(
    source,
    `  last_run_at: string;\n  last_error: string;`,
    `  last_run_at: string;\n  last_execution_target?: "macos_lab" | "macos_host";\n  last_error: string;`,
    "last_execution_target?: \"macos_lab\" | \"macos_host\"",
    "last execution target type",
  );
  return source;
})) changed.push("lib/types.ts");

if (await update("tool-service/server.mjs", (source) => {
  source = replaceRequired(
    source,
    'async function listFilesRecursive(directory, prefix = "") {',
    'async function listFilesRecursive(directory, prefix = "", skipTestOutput = false) {',
    'async function listFilesRecursive(directory, prefix = "", skipTestOutput = false)',
    "bounded skill file walker",
  );
  source = replaceRequired(
    source,
    '    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;\n    const absolute = join(directory, entry.name);\n    if (entry.isDirectory()) found.push(...await listFilesRecursive(absolute, relativePath));',
    '    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;\n    if (skipTestOutput && relativePath === ".test-output") continue;\n    const absolute = join(directory, entry.name);\n    if (entry.isDirectory()) found.push(...await listFilesRecursive(absolute, relativePath, skipTestOutput));',
    'skipTestOutput && [".test-output", ".alpha-runtime"].includes(relativePath)',
    "test-output traversal skip",
  );
  source = replaceRequired(
    source,
    '  for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {\n    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;',
    '  for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {\n    // External APFS/HFS volumes can expose AppleDouble sidecar files (._*).\n    // They are filesystem metadata, never skill source or test output.\n    if (entry.name.startsWith("._") || entry.name === ".DS_Store") continue;\n    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;',
    'entry.name.startsWith("._")',
    "AppleDouble skill source filter",
  );
  source = replaceRequired(
    source,
    '    const files = await listFilesRecursive(candidateDirectory);',
    '    const files = await listFilesRecursive(candidateDirectory, "", true);',
    'listFilesRecursive(candidateDirectory, "", true)',
    "skill install source enumeration",
  );
  source = replaceRequired(
    source,
    '    await fs.rename(staging, destination);\n    committed = true;',
    '    await fs.rename(staging, destination);\n    committed = true;\n    await fs.access(join(destination, skill.entrypoint));',
    'await fs.access(join(destination, skill.entrypoint))',
    "installed skill entrypoint check",
  );
  return source;
})) changed.push("tool-service/server.mjs");

if (await update("package.json", (source) => {
  const data = JSON.parse(source);
  if (["1.1.0-beta.14", "1.1.0-beta.15", "1.1.0-beta.16", "1.1.0-beta.17", "1.1.0-beta.18", "1.1.0-beta.19", "1.1.0-beta.20"].includes(data.version)) return source;
  data.version = "1.1.0-beta.14";
  return `${JSON.stringify(data, null, 2)}\n`;
})) changed.push("package.json");

await import(new URL("./apply-beta14-ticket-workflow.mjs", import.meta.url).href);

console.log(changed.length
  ? `Applied Alpha beta14 Auto Learn recovery: ${changed.join(", ")}`
  : "Alpha beta14 Auto Learn recovery already applied");
