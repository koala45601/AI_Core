import { getSettings } from "@/lib/settings-store";
import {
  executeTool,
  getVideoRun,
  getVideoRuntimeStatus,
  startVideoRun,
  stopVideoRun,
  videoRunFileResponse,
} from "@/lib/tool-client";
import {
  createCreateVideoProject,
  getCreateVideoProject,
  listCreateVideoProjects,
  saveCreateVideoPlan,
  updateCreateVideoProject,
} from "@/lib/create-video-store";
import { planCreateVideoProject } from "@/lib/create-video-director";

function asText(value: unknown, max = 200) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const runId = asText(url.searchParams.get("run_id"), 100);
    if (runId && url.searchParams.get("file") === "1") {
      const response = await videoRunFileResponse(runId);
      if (!response.ok) {
        const error = await response.json().catch(() => ({})) as { error?: string };
        return Response.json({ error: error.error || "เปิดไฟล์วิดีโอไม่สำเร็จ" }, { status: response.status });
      }
      return new Response(response.body, {
        status: 200,
        headers: {
          "Content-Type": response.headers.get("Content-Type") || "video/mp4",
          "Content-Length": response.headers.get("Content-Length") || "",
          "Cache-Control": "no-store",
        },
      });
    }

    const id = asText(url.searchParams.get("id"), 100);
    if (id) {
      const project = await getCreateVideoProject(id);
      if (!project) return Response.json({ error: "ไม่พบ Create Video Project" }, { status: 404 });
      return Response.json({ ok: true, project }, { headers: { "Cache-Control": "no-store" } });
    }
    const projects = await listCreateVideoProjects();
    return Response.json({ ok: true, projects }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "โหลด Create Video Project ไม่สำเร็จ" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const action = asText(body.action, 40);

    if (action === "create") {
      const project = await createCreateVideoProject(record(body.input));
      return Response.json({ ok: true, project }, { status: 201 });
    }

    if (action === "save") {
      const id = asText(body.id, 100);
      if (!id) throw new Error("ไม่พบ project id");
      const project = await updateCreateVideoProject(id, record(body.patch));
      return Response.json({ ok: true, project });
    }

    if (action === "plan") {
      const id = asText(body.id, 100);
      if (!id) throw new Error("ไม่พบ project id");
      const project = await getCreateVideoProject(id);
      if (!project) return Response.json({ error: "ไม่พบ Create Video Project" }, { status: 404 });
      await updateCreateVideoProject(id, { status: "PLANNING" });
      const settings = await getSettings();
      try {
        const plan = await planCreateVideoProject(project, settings);
        const saved = await saveCreateVideoPlan(id, plan, "WAITING");
        const runtime = await getVideoRuntimeStatus().catch(() => ({ generation_ready: false }));
        return Response.json({
          ok: true,
          project: saved,
          plan,
          phase: "PHASE_2_LOCAL",
          generation_ready: runtime.generation_ready === true,
          runtime,
          message: runtime.generation_ready === true
            ? "Director และ Shot Planner เสร็จแล้ว — Local Video พร้อม Generate Shot"
            : "Director และ Shot Planner เสร็จแล้ว — กด Prepare Local Video ครั้งแรกเพื่อดาวน์โหลด backend/model ลงเครื่อง",
        });
      } catch (error) {
        await updateCreateVideoProject(id, { status: "FAILED" }).catch(() => undefined);
        throw error;
      }
    }

    if (action === "hardware") {
      const settings = await getSettings();
      const capability = await executeTool("system_capability", {
        area: "development",
        commands: ["ffmpeg", "python3", "git", "ollama"],
      }, settings);
      const runtime = await getVideoRuntimeStatus().catch((error) => ({
        generation_ready: false,
        error: error instanceof Error ? error.message : "Local Video runtime ยังไม่พร้อม",
      }));
      return Response.json({
        ok: true,
        capability,
        runtime,
        policy: {
          memory_strategy: "LOAD_WORK_SAVE_UNLOAD",
          local_only: true,
          paid_api_required: false,
          backend: "wan2.1-mac-1.3b",
          note: "Video ถูกสร้างบน Mac ด้วย local Wan2.1 1.3B/MPS; ไม่ส่ง prompt ไป paid video API",
        },
      });
    }

    if (action === "runtime_status") {
      return Response.json({ ok: true, runtime: await getVideoRuntimeStatus() });
    }

    if (action === "prepare_local_video") {
      const run = await startVideoRun({ kind: "prepare" });
      return Response.json({ ok: true, run, message: "เริ่มเตรียม Local Video backend/model แล้ว" });
    }

    if (action === "generate_shot") {
      const id = asText(body.id, 100);
      const shotId = asText(body.shot_id, 100);
      if (!id || !shotId) throw new Error("ไม่พบ project/shot id");
      const project = await getCreateVideoProject(id);
      if (!project?.plan) throw new Error("Project ยังไม่มี Shot Plan");
      const plan = record(project.plan);
      const shots = Array.isArray(plan.shots) ? plan.shots : [];
      const shot = shots.map(record).find((item) => asText(item.shot_id, 100) === shotId);
      if (!shot) throw new Error("ไม่พบ Shot ที่ต้องการ Generate");
      const prompt = asText(shot.video_prompt, 6000);
      if (!prompt) throw new Error("Shot นี้ยังไม่มี Video Prompt");
      const settings = await getSettings();
      const run = await startVideoRun({
        kind: "generate",
        shot_id: shotId,
        prompt,
        negative_prompt: asText(shot.negative_prompt, 3000) || project.visual.negative_prompt,
        aspect_ratio: project.visual.aspect_ratio,
        quality: project.visual.quality,
        seed: project.visual.seed,
        ollama_model: settings.model,
      });
      return Response.json({ ok: true, run, local_only: true, paid_api_required: false });
    }

    if (action === "run_status") {
      const runId = asText(body.run_id, 100);
      if (!runId) throw new Error("ไม่พบ run id");
      return Response.json({ ok: true, run: await getVideoRun(runId) });
    }

    if (action === "run_stop") {
      const runId = asText(body.run_id, 100);
      if (!runId) throw new Error("ไม่พบ run id");
      return Response.json({ ok: true, run: await stopVideoRun(runId) });
    }

    return Response.json({ error: "ไม่รู้จัก action ของ Create Video" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Create Video ทำงานไม่สำเร็จ" }, { status: 500 });
  }
}
