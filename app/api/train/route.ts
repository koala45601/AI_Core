import { addMemory } from "@/lib/memory-store";
import { buildSkillAttempt, designHiddenSkillTests, designSkillGoal, synthesizeResearchRound, type SkillDefinition } from "@/lib/ollama";
import { evaluatePolicy } from "@/lib/policy.js";
import { searchWeb } from "@/lib/search";
import { getSettings } from "@/lib/settings-store";
import { executeTool } from "@/lib/tool-client";
import { SearchResult } from "@/lib/types";

const encoder = new TextEncoder();

function event(type: string, payload: Record<string, unknown> = {}) {
  return encoder.encode(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
}

function streamError(message: string, status = 400) {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(event("error", { message }));
      controller.enqueue(event("done"));
      controller.close();
    },
  }), { status, headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
}

function classifySkillFailure(reason: string): "infrastructure" | "candidate_timeout" | "candidate_syntax" | "candidate_behavior" | "capability_gap" {
  if (/(scandir|docker daemon|cannot connect|mount|resource busy|eagain|system error|tool service|ECONNREFUSED)/i.test(reason)) return "infrastructure";
  if (/(หมดเวลารอ docker|timed?\s*out|timeout)/i.test(reason)) return "candidate_timeout";
  if (/(syntax|parse error|indentation|compile)/i.test(reason)) return "candidate_syntax";
  if (/(dependency|package|trusted catalog|ไม่อยู่ใน trusted)/i.test(reason)) return "capability_gap";
  return "candidate_behavior";
}

function repairEntrypointContract(
  files: Array<{ path: string; content: string }>,
  skill: SkillDefinition,
): { files: Array<{ path: string; content: string }>; repairs: string[] } {
  const repairs: string[] = [];
  const repaired = files.map((file) => {
    if (file.path !== skill.entrypoint || skill.runtime !== "python") return file;
    const next = file.content.replace(
      /if\s+__name__\s*==\s*(["'])main\1\s*:/g,
      'if __name__ == "__main__":',
    );
    if (next !== file.content) repairs.push("แก้ Python main guard จากชื่อ main ที่ไม่มี underscore ให้เป็น __main__");
    return { ...file, content: next };
  });
  return { files: repaired, repairs };
}

interface TrainingInput {
  mode?: "skill" | "research";
  topic?: unknown;
  objective?: unknown;
  success_criteria?: unknown;
  max_rounds?: unknown;
  max_attempts?: unknown;
  target_confidence?: unknown;
  origin?: "auto_learn" | "skill_lab";
  run_id?: unknown;
  resume_checkpoint?: unknown;
}

export async function POST(request: Request) {
  let input: TrainingInput;
  try { input = await request.json() as TrainingInput; } catch { return streamError("รูปแบบคำสั่งฝึกไม่ถูกต้อง"); }

  const mode = input.mode === "research" ? "research" : "skill";
  const objective = String(input.objective || input.topic || "").trim().slice(0, 1000);
  const successCriteria = String(input.success_criteria || "").trim().slice(0, 2000);
  const settings = await getSettings();
  const requestedLimit = Number(input.max_attempts ?? input.max_rounds);
  const configuredLimit = mode === "skill" ? settings.skill_lab_max_attempts : settings.research_max_rounds;
  const selectedLimit = Number.isFinite(requestedLimit) ? Math.max(0, Math.round(requestedLimit)) : configuredLimit;
  const maxRounds = selectedLimit === 0 ? Infinity : selectedLimit;
  const targetConfidence = Math.min(95, Math.max(70, Number(input.target_confidence) || 85));
  if (!objective) return streamError(mode === "skill" ? "กรุณาใส่เป้าหมายความสามารถ" : "กรุณาใส่หัวข้อที่ต้องการศึกษา");

  const policy = evaluatePolicy(objective, settings);
  if (!policy.allowed) return streamError(policy.reason, 403);
  if (mode === "research" && !settings.web_search_enabled) return streamError("ต้องเปิดสวิตช์อินเทอร์เน็ตก่อนใช้โหมดค้นคว้า", 403);

  const stream = new ReadableStream({
    async start(controller) {
      try {
        if (mode === "research") await runResearch(controller, objective, maxRounds, targetConfidence, settings, request.signal);
        else await runSkillLab(controller, objective, successCriteria, maxRounds, settings, input.origin || "skill_lab", String(input.run_id || ""), input.resume_checkpoint, request.signal);
      } catch (error) {
        controller.enqueue(event("error", { message: error instanceof Error ? error.message : "การฝึกล้มเหลว" }));
      } finally {
        controller.enqueue(event("done"));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}

async function runSkillLab(
  controller: ReadableStreamDefaultController<Uint8Array>,
  objective: string,
  successCriteria: string,
  maxAttempts: number,
  settings: Awaited<ReturnType<typeof getSettings>>,
  origin: "auto_learn" | "skill_lab",
  runId: string,
  rawResumeCheckpoint: unknown,
  signal: AbortSignal,
) {
  let promptTokens = 0;
  let responseTokens = 0;
  let evidence: SearchResult[] = [];
  controller.enqueue(event("status", { label: "กำลังออกแบบเกณฑ์ทดสอบของ Skill Lab", round: 0 }));

  const needsExternalEvidence = /(?:official|ล่าสุด|framework|library|dependency|package|api|protocol|browser|เว็บไซต์|เว็บ|เครื่องมือภายนอก|เวอร์ชัน)/i.test(`${objective}\n${successCriteria}`)
    && !/(?:standard library|stdlib|ไม่ใช้ network|offline|ออฟไลน์)/i.test(`${objective}\n${successCriteria}`);
  if (settings.web_search_enabled && needsExternalEvidence) {
    try {
      controller.enqueue(event("status", { label: "กำลังค้นเอกสารเครื่องมือที่เชื่อถือได้", round: 0 }));
      evidence = await searchWeb(`${objective} official documentation open source tool`, settings);
    } catch (error) {
      controller.enqueue(event("notice", { message: `ค้นเอกสารไม่ได้ จึงออกแบบจากความรู้ในโมเดล: ${error instanceof Error ? error.message : "unknown error"}` }));
    }
  } else {
    controller.enqueue(event("notice", { message: "เป้าหมายนี้เป็นงาน deterministic ที่ใช้ standard library จึงข้าม web research และเริ่มสร้างสกิลทันที" }));
  }

  const resumeCheckpoint = rawResumeCheckpoint && typeof rawResumeCheckpoint === "object" ? rawResumeCheckpoint as Record<string, unknown> : null;
  const resumedSkill = resumeCheckpoint?.skill && typeof resumeCheckpoint.skill === "object" ? resumeCheckpoint.skill as SkillDefinition : null;
  const plan = resumedSkill
    ? { status: "ready" as const, reason: "แก้ต่อจาก checkpoint ของ attempt ก่อน", skill: resumedSkill, prompt_tokens: 0, response_tokens: 0 }
    : await designSkillGoal(objective, successCriteria, evidence, settings, signal);
  promptTokens += plan.prompt_tokens;
  responseTokens += plan.response_tokens;
  if (plan.status === "blocked" || !plan.skill) {
    controller.enqueue(event("complete", {
      mode: "skill", success: false, objective, attempts: 0,
      reason: plan.reason || "เป้าหมายนี้ต้องใช้เครื่องมือที่ยังไม่อยู่ใน trusted catalog",
      summary: plan.reason || "ยังสร้างสกิลไม่ได้", confidence: 0, rounds: 0, reached_target: false,
      cleanup: "ไม่สร้าง environment เพราะแผนไม่ผ่านข้อจำกัด",
    }));
    controller.enqueue(event("usage", { prompt_tokens: promptTokens, response_tokens: responseTokens, total_tokens: promptTokens + responseTokens, context_limit: settings.max_context_tokens, unlimited_messages: true }));
    return;
  }

  controller.enqueue(event("skill_plan", { skill: plan.skill, reason: plan.reason, sources: evidence }));
  controller.enqueue(event("status", { label: "กำลังสร้าง hidden validation tests ที่ผู้เขียนสกิลไม่เห็น", round: 0 }));
  let hiddenTests: Awaited<ReturnType<typeof designHiddenSkillTests>>["tests"] = Array.isArray(resumeCheckpoint?.hidden_test_cases) ? resumeCheckpoint.hidden_test_cases as Awaited<ReturnType<typeof designHiddenSkillTests>>["tests"] : [];
  if (!hiddenTests.length) {
    try {
      const hidden = await designHiddenSkillTests(objective, successCriteria, plan.skill, settings, signal);
      hiddenTests = hidden.tests;
      promptTokens += hidden.prompt_tokens;
      responseTokens += hidden.response_tokens;
    } catch (error) {
      controller.enqueue(event("notice", { message: `สร้าง hidden tests ไม่สำเร็จ: ${error instanceof Error ? error.message : "unknown error"}` }));
    }
  } else {
    controller.enqueue(event("notice", { message: "โหลด hidden tests และ source code จาก checkpoint เพื่อแก้ต่อ ไม่เริ่มจากศูนย์" }));
  }
  let previousFailure = String(resumeCheckpoint?.failure || "");
  let previousFiles = Array.isArray(resumeCheckpoint?.files)
    ? (resumeCheckpoint.files as Array<Record<string, unknown>>).filter((item) => typeof item?.path === "string" && typeof item?.content === "string").map((item) => ({ path: String(item.path), content: String(item.content) })).slice(0, 12)
    : [];
  const failureHistory = Array.isArray(resumeCheckpoint?.failure_history) ? (resumeCheckpoint.failure_history as Array<Record<string, unknown>>).slice(-8) : [];
  let strategyLevel = Math.max(0, Number(resumeCheckpoint?.strategy_level || 0));
  const failureCounts = new Map<string, number>();
  for (const item of failureHistory) {
    const signature = String(item.signature || "");
    if (signature) failureCounts.set(signature, (failureCounts.get(signature) || 0) + 1);
  }
  let lastReason = "";
  let lastConfidence = 0;
  let completedAttempts = 0;
  let lastCheckpoint: Record<string, unknown> | null = resumeCheckpoint;
  let infrastructureRetries = 0;
  const infrastructureRetryLimit = settings.auto_learn_retry_limit === 0 ? Infinity : Math.max(1, settings.auto_learn_retry_limit);
  const infrastructureFailureCounts = new Map<string, number>();
  let retryFiles: Array<{ path: string; content: string }> | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    controller.enqueue(event("status", { label: retryFiles ? `Attempt ${attempt}: รีเซ็ตระบบทดสอบแล้ว ใช้ source เดิมทดสอบซ้ำ` : `Attempt ${attempt}: กำลังสร้างสกิลใน environment แยก`, round: attempt }));
    const build = retryFiles
      ? { files: retryFiles, notes: "ทดสอบ source เดิมหลังซ่อม infrastructure", blocked_reason: "", prompt_tokens: 0, response_tokens: 0 }
      : await buildSkillAttempt(objective, successCriteria, plan.skill, previousFailure, previousFiles, settings, signal);
    retryFiles = null;
    promptTokens += build.prompt_tokens;
    responseTokens += build.response_tokens;
    if (build.blocked_reason) {
      previousFailure = build.blocked_reason;
      controller.enqueue(event("attempt", { round: attempt, passed: false, query: `Attempt ${attempt}`, confidence: 0, gaps: [build.blocked_reason], reason: build.blocked_reason }));
      break;
    }
    if (!build.files.length) {
      previousFailure = "โมเดลไม่ได้สร้างไฟล์สกิล";
      controller.enqueue(event("attempt", { round: attempt, passed: false, query: `Attempt ${attempt}`, confidence: 0, gaps: [previousFailure], reason: previousFailure }));
      continue;
    }
    const contractRepair = repairEntrypointContract(build.files, plan.skill);
    previousFiles = contractRepair.files;
    if (contractRepair.repairs.length) {
      controller.enqueue(event("contract_repair", {
        round: attempt,
        label: "ซ่อม entrypoint contract ที่พิสูจน์ได้ก่อนทดสอบ",
        repairs: contractRepair.repairs,
      }));
    }

    controller.enqueue(event("status", { label: `Attempt ${attempt}: กำลังรัน test ใน Docker แบบปิดเครือข่าย`, round: attempt }));
    let result: Record<string, unknown>;
    try {
      result = await executeTool("skill_lab_test", {
        goal_id: plan.skill.id, objective, success_criteria: successCriteria,
        run_id: runId || `skill-lab-${plan.skill.id}`, attempt, skill: plan.skill, files: previousFiles, hidden_test_cases: hiddenTests,
        verification_scope: `${plan.skill.test_cases.length} visible fixtures + ${hiddenTests.length} hidden fixtures สำหรับ ${plan.skill.description}`,
        test_case_limit: settings.skill_test_case_limit,
        origin, cleanup_run: attempt === maxAttempts,
      }, settings, signal);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Docker test ทำงานไม่สำเร็จ";
      result = { ok: false, passed: false, reason, failure_kind: classifySkillFailure(reason) };
    }
    const tests = Array.isArray(result.tests) ? result.tests : [];
    const skillResult = result.skill && typeof result.skill === "object" ? result.skill as Record<string, unknown> : {};
    const confidence = Number(skillResult.generalization_confidence || 0);
    const reason = String(result.reason || (result.passed ? "ผ่านทุก test" : "ยังไม่ผ่านเกณฑ์"));
    const failureKind = result.passed ? "" : String(result.failure_kind || classifySkillFailure(reason));
    lastReason = reason;
    lastConfidence = confidence;
    if (failureKind === "infrastructure") {
      infrastructureRetries += 1;
      const infrastructureSignature = reason.replace(/\b\d+\b/g, "#").slice(0, 1000);
      const sameInfrastructureFailures = (infrastructureFailureCounts.get(infrastructureSignature) || 0) + 1;
      infrastructureFailureCounts.set(infrastructureSignature, sameInfrastructureFailures);
      controller.enqueue(event("infrastructure_repair", {
        round: attempt,
        label: sameInfrastructureFailures >= 3
          ? "ระบบทดสอบผิดแบบเดิมซ้ำ—หยุด retry วิธีเดิมและเก็บ checkpoint"
          : "ตรวจพบว่าระบบทดสอบเสีย—ซ่อม environment แล้วทดสอบ source เดิมซ้ำ",
        reason,
        retry: infrastructureRetries,
        repeated: sameInfrastructureFailures,
      }));
      await executeTool("skill_lab_cleanup", { run_id: runId || `skill-lab-${plan.skill.id}` }, settings, signal).catch(() => ({}));
      if (infrastructureRetries <= infrastructureRetryLimit && sameInfrastructureFailures < 3) {
        retryFiles = previousFiles;
        attempt -= 1;
        continue;
      }
    }
    completedAttempts = Math.max(completedAttempts, attempt);
    const failedChecks = tests.filter((test) => test && typeof test === "object" && (test as Record<string, unknown>).passed !== true).map((test) => {
      const record = test as Record<string, unknown>;
      return {
        name: record.name,
        exit_code: record.exit_code,
        checks: record.checks,
        stdout: String(record.stdout || "").slice(0, 2000),
        stderr: String(record.stderr || "").slice(0, 1000),
      };
    });
    const signatureChecks = failedChecks.map((item) => ({ name: item.name, exit_code: item.exit_code, checks: item.checks, stdout: item.stdout }));
    const failureSignature = result.passed ? "" : `${failureKind}:${reason}:${JSON.stringify(signatureChecks)}`.slice(0, 3000);
    const repeatedCount = failureSignature ? (failureCounts.get(failureSignature) || 0) + 1 : 0;
    if (failureSignature) failureCounts.set(failureSignature, repeatedCount);
    if (!result.passed) failureHistory.push({ attempt, failure_kind: failureKind, reason, signature: failureSignature, failed_checks: failedChecks, strategy_level: strategyLevel, at: Date.now() });
    let repairEvidence: SearchResult[] = [];
    if (!result.passed && repeatedCount >= 2 && settings.web_search_enabled) {
      strategyLevel += 1;
      controller.enqueue(event("strategy_change", { round: attempt, label: `พบ failure เดิมซ้ำ ${repeatedCount} ครั้ง—บังคับเปลี่ยนวิธีแก้`, strategy_level: strategyLevel }));
      try {
        repairEvidence = await searchWeb(`${plan.skill.runtime} ${plan.skill.name} ${reason} official documentation troubleshooting`, settings);
      } catch { /* continue with local diagnostics */ }
    }
    controller.enqueue(event("attempt", {
      round: attempt, passed: result.passed === true, query: `Attempt ${attempt}: ${build.notes || plan.skill.name}`,
      confidence, gaps: result.passed ? [] : [reason], reason, failure_kind: failureKind, tests,
    }));
    const checkpoint = {
      version: 1, skill: plan.skill, files: previousFiles, hidden_test_cases: hiddenTests,
      failure: result.passed ? "" : JSON.stringify({ failure_kind: failureKind, reason, repeated_count: repeatedCount, required_strategy: repeatedCount >= 2 ? "ห้ามใช้วิธีเดิม ต้องเปลี่ยนอัลกอริทึมหรือสถาปัตยกรรมโดยรักษา test ที่ผ่านแล้ว" : "ซ่อมตามผล test", validation_errors: result.validation_errors || [], failed_checks: failedChecks, evidence: repairEvidence.slice(0, 5) }).slice(0, 12_000),
      failure_history: failureHistory.slice(-8), strategy_level: strategyLevel, stalled: repeatedCount >= 3, attempts_completed: attempt,
    };
    lastCheckpoint = checkpoint;
    controller.enqueue(event("checkpoint", { label: `บันทึก checkpoint หลัง Attempt ${attempt}`, checkpoint }));

    if (result.passed === true) {
      await addMemory(`อัลฟ่าเรียนรู้สกิล “${plan.skill.name}” (${plan.skill.id}) สำเร็จ ใช้สำหรับ: ${plan.skill.description}`, "research");
      if (Array.isArray(result.artifacts)) controller.enqueue(event("artifact", { artifacts: result.artifacts }));
      controller.enqueue(event("complete", {
        mode: "skill", success: true, objective, skill: result.skill, report: result.report,
        artifacts: result.artifacts || [], attempts: attempt, rounds: attempt, confidence,
        verified_pass_rate: Number(skillResult.verified_pass_rate || 0),
        generalization_confidence: confidence,
        reached_target: true, summary: `สร้างและติดตั้งสกิล ${plan.skill.name} สำเร็จ ผ่าน test ทั้งหมด ${tests.length} รายการ`,
        cleanup: "ลบ environment, test output, container และ image ชั่วคราวแล้ว เหลือเฉพาะสกิลที่ติดตั้ง",
      }));
      controller.enqueue(event("usage", { prompt_tokens: promptTokens, response_tokens: responseTokens, total_tokens: promptTokens + responseTokens, context_limit: settings.max_context_tokens, unlimited_messages: true }));
      return;
    }
    previousFailure = checkpoint.failure;
    if (checkpoint.stalled) {
      lastReason = `failure เดิมเกิดซ้ำ ${repeatedCount} ครั้งแม้เปลี่ยนกลยุทธ์ จึงพัก checkpoint เพื่อไม่ให้วนกินเวลาทั้ง session`;
      break;
    }
  }

  controller.enqueue(event("complete", {
    mode: "skill", success: false, objective, attempts: completedAttempts, rounds: completedAttempts,
    confidence: lastConfidence, reached_target: false, reason: lastReason || "ครบจำนวน attempt แล้วยังไม่ผ่านเกณฑ์",
    summary: `ยังสร้างสกิลไม่สำเร็จหลัง ${completedAttempts} attempt: ${lastReason || "ครบจำนวน attempt แล้วยังไม่ผ่านเกณฑ์"}`,
    checkpoint: lastCheckpoint || { version: 1, skill: plan.skill, files: previousFiles, hidden_test_cases: hiddenTests, failure: previousFailure || lastReason, failure_history: failureHistory.slice(-8), strategy_level: strategyLevel, attempts_completed: completedAttempts },
    cleanup: "ลบ environment และสิ่งชั่วคราวทั้งหมดแล้ว ไม่มีสกิลที่ไม่ผ่านถูกติดตั้ง",
  }));
  controller.enqueue(event("usage", { prompt_tokens: promptTokens, response_tokens: responseTokens, total_tokens: promptTokens + responseTokens, context_limit: settings.max_context_tokens, unlimited_messages: true }));
}

async function runResearch(
  controller: ReadableStreamDefaultController<Uint8Array>,
  topic: string,
  maxRounds: number,
  targetConfidence: number,
  settings: Awaited<ReturnType<typeof getSettings>>,
  signal: AbortSignal,
) {
  let query = topic;
  let summary = "";
  let confidence = 0;
  let promptTokens = 0;
  let responseTokens = 0;
  const sources = new Map<string, SearchResult>();
  let completedRounds = 0;
  controller.enqueue(event("status", { label: "ตรวจสอบหัวข้อกับกฎแล้ว", round: 0 }));
  for (let round = 1; round <= maxRounds; round += 1) {
    const roundPolicy = evaluatePolicy(query, settings);
    if (!roundPolicy.allowed) throw new Error("คำค้นรอบถัดไปถูกหยุดโดยกฎของคุณ");
    controller.enqueue(event("status", { label: `รอบ ${round}: กำลังค้น “${query}”`, round }));
    const results = await searchWeb(query, settings);
    if (!results.length) throw new Error("ไม่พบแหล่งข้อมูลที่ผ่านกฎเว็บไซต์");
    for (const result of results) sources.set(result.url, result);
    controller.enqueue(event("status", { label: `รอบ ${round}: กำลังอ่านและหาช่องว่าง`, round }));
    const synthesis = await synthesizeResearchRound(topic, summary, results, settings, signal);
    summary = synthesis.summary || summary;
    confidence = synthesis.confidence;
    promptTokens += synthesis.prompt_tokens;
    responseTokens += synthesis.response_tokens;
    completedRounds = round;
    controller.enqueue(event("round", { round, query, confidence, gaps: synthesis.gaps, sources: results }));
    if (confidence >= targetConfidence || synthesis.gaps.length === 0) break;
    query = synthesis.next_query || `${topic} ${synthesis.gaps[0]}`;
  }
  if (!summary) throw new Error("อัลฟ่าไม่สามารถสร้างบทสรุปจากหลักฐานได้");
  const sourceList = [...sources.values()];
  await addMemory(`[ความรู้จากโหมดฝึก: ${topic}]\n${summary}\n\nแหล่งข้อมูล:\n${sourceList.slice(0, 12).map((source) => `- ${source.title}: ${source.url}`).join("\n")}`, "research");
  controller.enqueue(event("usage", { prompt_tokens: promptTokens, response_tokens: responseTokens, total_tokens: promptTokens + responseTokens, context_limit: settings.max_context_tokens, unlimited_messages: true }));
  controller.enqueue(event("complete", { mode: "research", success: true, topic, summary, confidence, rounds: completedRounds, sources: sourceList, reached_target: confidence >= targetConfidence }));
}
