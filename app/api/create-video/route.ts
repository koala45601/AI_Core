import { getSettings } from "@/lib/settings-store";
import { executeTool } from "@/lib/tool-client";
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

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
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
      const project = await createCreateVideoProject(body.input && typeof body.input === "object" && !Array.isArray(body.input)
        ? body.input as Record<string, unknown>
        : {});
      return Response.json({ ok: true, project }, { status: 201 });
    }

    if (action === "save") {
      const id = asText(body.id, 100);
      if (!id) throw new Error("ไม่พบ project id");
      const patch = body.patch && typeof body.patch === "object" && !Array.isArray(body.patch)
        ? body.patch as Record<string, unknown>
        : {};
      const project = await updateCreateVideoProject(id, patch);
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
        return Response.json({
          ok: true,
          project: saved,
          plan,
          phase: "PHASE_1",
          generation_ready: false,
          message: "Director และ Shot Planner เสร็จแล้ว — ยังไม่ได้ติดตั้งหรือโหลด Video Model",
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
        commands: ["ffmpeg", "python3", "git"],
      }, settings);
      return Response.json({
        ok: true,
        capability,
        policy: {
          memory_strategy: "LOAD_WORK_SAVE_UNLOAD",
          auto_install_video_model: false,
          video_model_selected: false,
          note: "Phase 1 ตรวจ hardware/dependencies เท่านั้น ยังไม่ติดตั้ง Video Model อัตโนมัติ",
        },
      });
    }

    return Response.json({ error: "ไม่รู้จัก action ของ Create Video" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Create Video ทำงานไม่สำเร็จ" }, { status: 500 });
  }
}
