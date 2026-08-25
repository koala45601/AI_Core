"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type ProjectStatus = "DRAFT" | "PLANNING" | "STORYBOARD" | "WAITING" | "COMPLETED" | "FAILED" | "CANCELLED";

interface VideoProject {
  id: string;
  name: string;
  story: string;
  screenplay: string;
  target_duration_seconds: number;
  mode: "auto" | "manual";
  visual: {
    style: string;
    aspect_ratio: string;
    resolution: string;
    fps: number;
    quality: string;
    seed: number | null;
    negative_prompt: string;
  };
  plan: DirectorPlan | null;
  status: ProjectStatus;
  created_at: number;
  updated_at: number;
}

interface DirectorPlan {
  schema_version?: string;
  story_summary?: string;
  story_beats?: string[];
  transformation_timeline?: string[];
  characters?: Array<{
    character_id: string;
    name: string;
    identity?: Record<string, unknown>;
    default_outfit?: Record<string, string>;
    states?: Array<{ state_id: string; label: string; description?: string }>;
  }>;
  locations?: Array<{
    location_id: string;
    name: string;
    architecture?: string;
    lighting?: string;
    weather?: string;
    time?: string;
    color_palette?: string;
    damage_state?: string;
  }>;
  scenes?: Array<{ scene_id: string; title: string; summary: string; duration_seconds: number }>;
  shots?: Array<{
    shot_id: string;
    scene_id: string;
    duration: number;
    location_id: string;
    character_ids: string[];
    character_states?: Record<string, string>;
    action: string;
    camera?: { shot_type?: string; angle?: string; movement?: string };
    video_prompt: string;
    negative_prompt?: string;
    continuity_before?: Record<string, unknown>;
    continuity_after?: Record<string, unknown>;
  }>;
  validation?: {
    total_shot_duration?: number;
    target_duration?: number;
    continuity_checked?: boolean;
    invalid_character_refs?: string[];
    invalid_location_refs?: string[];
    repaired_responses?: number;
  };
}

interface HardwareSnapshot {
  capability?: Record<string, unknown>;
  policy?: { memory_strategy?: string; auto_install_video_model?: boolean; video_model_selected?: boolean; note?: string };
}

const DURATION_OPTIONS = [5, 10, 15, 30, 60, 180, 300];

async function api(body: Record<string, unknown>) {
  const response = await fetch("/api/create-video", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json() as Record<string, unknown> & { error?: string };
  if (!response.ok) throw new Error(data.error || "Create Video ทำงานไม่สำเร็จ");
  return data;
}

function statusLabel(status: ProjectStatus) {
  return ({
    DRAFT: "Draft",
    PLANNING: "Director กำลังวางแผน",
    STORYBOARD: "Storyboard",
    WAITING: "พร้อมตรวจ Shot Plan",
    COMPLETED: "เสร็จแล้ว",
    FAILED: "มีข้อผิดพลาด",
    CANCELLED: "ยกเลิก",
  } as Record<ProjectStatus, string>)[status];
}

export default function CreateVideoStudio() {
  const [projects, setProjects] = useState<VideoProject[]>([]);
  const [active, setActive] = useState<VideoProject | null>(null);
  const [name, setName] = useState("My Film");
  const [story, setStory] = useState("");
  const [screenplay, setScreenplay] = useState("");
  const [duration, setDuration] = useState(60);
  const [customDuration, setCustomDuration] = useState("");
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  const [style, setStyle] = useState("cinematic");
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [resolution, setResolution] = useState("1280x720");
  const [fps, setFps] = useState(24);
  const [quality, setQuality] = useState("balanced");
  const [seed, setSeed] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [plan, setPlan] = useState<DirectorPlan | null>(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("Phase 1 พร้อม: Project + Director + Shot Planner + Continuity");
  const [hardware, setHardware] = useState<HardwareSnapshot | null>(null);
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);

  const effectiveDuration = useMemo(() => {
    const custom = Number(customDuration);
    return customDuration.trim() ? Math.min(1800, Math.max(5, Math.round(custom || 60))) : duration;
  }, [customDuration, duration]);

  async function loadProjects(selectId?: string) {
    const response = await fetch("/api/create-video", { cache: "no-store" });
    const data = await response.json() as { projects?: VideoProject[]; error?: string };
    if (!response.ok) throw new Error(data.error || "โหลด Project ไม่สำเร็จ");
    const next = data.projects ?? [];
    setProjects(next);
    if (selectId) {
      const selected = next.find((item) => item.id === selectId) || null;
      if (selected) chooseProject(selected);
    }
  }

  function chooseProject(project: VideoProject) {
    setActive(project);
    setName(project.name);
    setStory(project.story);
    setScreenplay(project.screenplay);
    setDuration(DURATION_OPTIONS.includes(project.target_duration_seconds) ? project.target_duration_seconds : 60);
    setCustomDuration(DURATION_OPTIONS.includes(project.target_duration_seconds) ? "" : String(project.target_duration_seconds));
    setMode(project.mode);
    setStyle(project.visual.style);
    setAspectRatio(project.visual.aspect_ratio);
    setResolution(project.visual.resolution);
    setFps(project.visual.fps);
    setQuality(project.visual.quality);
    setSeed(project.visual.seed === null ? "" : String(project.visual.seed));
    setNegativePrompt(project.visual.negative_prompt);
    setPlan(project.plan);
    setMessage(`เปิด ${project.name} · ${statusLabel(project.status)}`);
  }

  useEffect(() => {
    void loadProjects().catch((error) => setMessage(error instanceof Error ? error.message : "โหลด Project ไม่สำเร็จ"));
    void Promise.all([
      api({ action: "hardware" }).catch((error) => ({ error: error instanceof Error ? error.message : "ตรวจ hardware ไม่สำเร็จ" })),
      fetch("/api/health", { cache: "no-store" }).then((response) => response.json()).catch(() => null),
    ]).then(([hardwareResult, healthResult]) => {
      if (hardwareResult && !hardwareResult.error) setHardware(hardwareResult as HardwareSnapshot);
      setHealth(healthResult && typeof healthResult === "object" ? healthResult as Record<string, unknown> : null);
    });
  }, []);

  function visual() {
    return {
      style,
      aspect_ratio: aspectRatio,
      resolution,
      fps,
      quality,
      seed: seed.trim() ? Math.max(0, Math.round(Number(seed) || 0)) : null,
      negative_prompt: negativePrompt,
    };
  }

  async function createProject(event: FormEvent) {
    event.preventDefault();
    if (!story.trim() && !screenplay.trim()) {
      setMessage("ใส่ Story หรือ Screenplay ก่อนสร้าง Project");
      return;
    }
    setBusy("create");
    try {
      const data = await api({
        action: "create",
        input: { name, story, screenplay, target_duration_seconds: effectiveDuration, mode, visual: visual() },
      });
      const project = data.project as VideoProject;
      setActive(project);
      setPlan(project.plan);
      setMessage(`สร้าง Project แล้ว · ${project.id}`);
      await loadProjects(project.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "สร้าง Project ไม่สำเร็จ");
    } finally {
      setBusy("");
    }
  }

  async function saveProject() {
    if (!active) return;
    setBusy("save");
    try {
      const data = await api({
        action: "save",
        id: active.id,
        patch: { name, story, screenplay, target_duration_seconds: effectiveDuration, mode, visual: visual(), plan },
      });
      const project = data.project as VideoProject;
      setActive(project);
      setPlan(project.plan);
      setMessage("บันทึก Project แล้ว");
      await loadProjects(project.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "บันทึก Project ไม่สำเร็จ");
    } finally {
      setBusy("");
    }
  }

  async function runDirector() {
    if (!active) {
      setMessage("สร้าง Project ก่อนเรียก AI Director");
      return;
    }
    setBusy("plan");
    setMessage("AI Director กำลังทำ Story Pass → Scene Pass → Shot Pass แบบ Layered Context…");
    try {
      await api({
        action: "save",
        id: active.id,
        patch: { name, story, screenplay, target_duration_seconds: effectiveDuration, mode, visual: visual() },
      });
      const data = await api({ action: "plan", id: active.id });
      const project = data.project as VideoProject;
      setActive(project);
      setPlan(data.plan as DirectorPlan);
      setMessage(String(data.message || "Director วาง Shot Plan เสร็จแล้ว"));
      await loadProjects(project.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "AI Director ทำงานไม่สำเร็จ");
    } finally {
      setBusy("");
    }
  }

  function updateShot(index: number, patch: Record<string, unknown>) {
    if (!plan?.shots) return;
    const shots = plan.shots.map((shot, shotIndex) => shotIndex === index ? { ...shot, ...patch } : shot);
    const total = shots.reduce((sum, shot) => sum + Math.max(0, Number(shot.duration || 0)), 0);
    setPlan({ ...plan, shots, validation: { ...(plan.validation || {}), total_shot_duration: total, target_duration: effectiveDuration } });
  }

  const capabilityText = useMemo(() => {
    if (!hardware?.capability) return "กำลังตรวจ Mac / FFmpeg / Metal prerequisites…";
    const raw = JSON.stringify(hardware.capability);
    const ffmpeg = /ffmpeg/i.test(raw) ? "FFmpeg: ตรวจแล้ว" : "FFmpeg: ยังไม่ยืนยัน";
    const apple = /apple|darwin|macos|arm64|m4/i.test(raw) ? "Apple Silicon: ตรวจพบ" : "Apple Silicon: รอผลละเอียด";
    return `${apple} · ${ffmpeg}`;
  }, [hardware]);

  return (
    <div className="content-view create-video-view">
      <section className="create-video-hero">
        <div>
          <span className="section-kicker">LOCAL AI FILM STUDIO · PHASE 1</span>
          <h2>Create Video</h2>
          <p>วาง Story → Character/Location Registry → Scene → Shot Plan ด้วย Local Director ก่อนโหลด Video Model จริง</p>
        </div>
        <div className="create-video-resource-card">
          <strong>Memory-Constrained M4 / 16GB</strong>
          <span>LOAD → WORK → SAVE → UNLOAD</span>
          <small>{capabilityText}</small>
          <small>Director: {String(health?.model || health?.model_name || "Local Ollama")}</small>
          <b>Video Model: ยังไม่เลือก / ไม่ติดตั้งอัตโนมัติ</b>
        </div>
      </section>

      <div className="create-video-layout">
        <aside className="video-project-list">
          <div className="video-panel-head"><strong>Projects</strong><span>{projects.length}</span></div>
          <div className="video-project-scroll">
            {projects.map((project) => (
              <button type="button" key={project.id} className={active?.id === project.id ? "active" : ""} onClick={() => chooseProject(project)}>
                <strong>{project.name}</strong>
                <span>{project.target_duration_seconds}s · {project.plan?.shots?.length || 0} shots</span>
                <small>{statusLabel(project.status)} · {new Date(project.updated_at).toLocaleString("th-TH")}</small>
              </button>
            ))}
            {!projects.length && <p>ยังไม่มี Film Project</p>}
          </div>
        </aside>

        <div className="video-workspace">
          <form className="video-project-form" onSubmit={createProject}>
            <div className="video-section-title"><div><span className="section-kicker">PROJECT</span><h3>{active ? "Project Settings" : "New Film Project"}</h3></div><span>{active ? active.id.slice(0, 8) : "ยังไม่บันทึก"}</span></div>
            <div className="video-grid two">
              <label><span>Project Name</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
              <label><span>Mode</span><select value={mode} onChange={(event) => setMode(event.target.value as "auto" | "manual")}><option value="auto">AUTO DIRECTOR</option><option value="manual">MANUAL / ADVANCED</option></select></label>
            </div>
            <label><span>Story / Prompt</span><textarea rows={3} value={story} onChange={(event) => setStory(event.target.value)} placeholder="Create a 1-minute cinematic horror movie about Rin escaping from an infected city." /></label>
            <label><span>Full Screenplay</span><textarea rows={6} value={screenplay} onChange={(event) => setScreenplay(event.target.value)} placeholder="ใส่ screenplay เต็มได้ Director จะทำ Story Pass ก่อนและไม่ยัด screenplay เต็มเข้า prompt ของทุก shot" /></label>

            <div className="video-grid four">
              <label><span>Target Duration</span><select value={customDuration ? "custom" : duration} onChange={(event) => { if (event.target.value === "custom") setCustomDuration(String(effectiveDuration)); else { setDuration(Number(event.target.value)); setCustomDuration(""); } }}>
                {DURATION_OPTIONS.map((value) => <option key={value} value={value}>{value < 60 ? `${value} sec` : `${value / 60} minute${value > 60 ? "s" : ""}`}</option>)}<option value="custom">Custom</option>
              </select></label>
              {customDuration && <label><span>Custom seconds</span><input type="number" min="5" max="1800" value={customDuration} onChange={(event) => setCustomDuration(event.target.value)} /></label>}
              <label><span>Style</span><input value={style} onChange={(event) => setStyle(event.target.value)} /></label>
              <label><span>Aspect Ratio</span><select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)}><option>16:9</option><option>9:16</option><option>1:1</option><option value="custom">Custom</option></select></label>
              <label><span>Resolution</span><select value={resolution} onChange={(event) => setResolution(event.target.value)}><option>854x480</option><option>1280x720</option><option>1920x1080</option></select></label>
              <label><span>FPS</span><select value={fps} onChange={(event) => setFps(Number(event.target.value))}>{[12, 15, 24, 25, 30].map((value) => <option key={value}>{value}</option>)}</select></label>
              <label><span>Quality</span><select value={quality} onChange={(event) => setQuality(event.target.value)}><option value="fast">Fast</option><option value="balanced">Balanced</option><option value="quality">Quality</option></select></label>
              <label><span>Seed</span><input inputMode="numeric" value={seed} onChange={(event) => setSeed(event.target.value)} placeholder="random" /></label>
            </div>
            <label><span>Negative Prompt</span><input value={negativePrompt} onChange={(event) => setNegativePrompt(event.target.value)} placeholder="optional global negative prompt" /></label>

            <div className="video-actions">
              {!active && <button type="submit" disabled={Boolean(busy)}>สร้าง Project</button>}
              {active && <button type="button" onClick={() => void saveProject()} disabled={Boolean(busy)}>บันทึก</button>}
              <button className="primary" type="button" onClick={() => void runDirector()} disabled={!active || Boolean(busy)}>{busy === "plan" ? "Director กำลังวางแผน…" : "AI Director: Generate Shot Plan"}</button>
            </div>
            <div className={`video-status ${active?.status === "FAILED" ? "error" : ""}`}>{message}</div>
          </form>

          {plan && <>
            <section className="video-registry-grid">
              <article>
                <div className="video-panel-head"><strong>Character Registry</strong><span>{plan.characters?.length || 0}</span></div>
                <div className="registry-scroll">{plan.characters?.map((character) => <div className="registry-card" key={character.character_id}><b>{character.character_id}</b><strong>{character.name}</strong><small>{String(character.identity?.face_description || "Identity locked")}</small><span>{character.states?.map((state) => state.label).join(" · ") || "BASE"}</span></div>)}</div>
              </article>
              <article>
                <div className="video-panel-head"><strong>Location Registry</strong><span>{plan.locations?.length || 0}</span></div>
                <div className="registry-scroll">{plan.locations?.map((location) => <div className="registry-card" key={location.location_id}><b>{location.location_id}</b><strong>{location.name}</strong><small>{location.lighting || location.architecture || "Location identity locked"}</small><span>{[location.time, location.weather].filter(Boolean).join(" · ")}</span></div>)}</div>
              </article>
            </section>

            <section className="shot-plan-panel">
              <div className="video-section-title"><div><span className="section-kicker">SHOT PLANNER</span><h3>Timeline · {plan.shots?.length || 0} shots</h3></div><span>{plan.validation?.total_shot_duration || 0}s / {plan.validation?.target_duration || effectiveDuration}s</span></div>
              <p className="video-story-summary">{plan.story_summary}</p>
              <div className="shot-card-list">
                {plan.shots?.map((shot, index) => (
                  <article className="shot-card" key={shot.shot_id}>
                    <header><div><b>{shot.shot_id}</b><span>{shot.scene_id} · {shot.duration}s</span></div><span>{shot.location_id}</span></header>
                    <div className="shot-meta"><span>Characters: {shot.character_ids?.join(", ") || "—"}</span><span>Camera: {[shot.camera?.shot_type, shot.camera?.angle, shot.camera?.movement].filter(Boolean).join(" · ") || "—"}</span></div>
                    <label><span>Action</span><input value={shot.action} onChange={(event) => updateShot(index, { action: event.target.value })} /></label>
                    <label><span>Video Prompt</span><textarea rows={3} value={shot.video_prompt} onChange={(event) => updateShot(index, { video_prompt: event.target.value })} /></label>
                    <div className="shot-inline"><label><span>Duration</span><input type="number" min="2" max="12" value={shot.duration} onChange={(event) => updateShot(index, { duration: Math.min(12, Math.max(2, Number(event.target.value) || 2)) })} /></label><button type="button" disabled title="Phase 2 จะเชื่อม Local Video Adapter">Generate Shot — Phase 2</button></div>
                  </article>
                ))}
              </div>
              <div className="video-validation-row"><span className={plan.validation?.continuity_checked ? "pass" : "warn"}>{plan.validation?.continuity_checked ? "✓ Continuity references valid" : "! Continuity ต้องตรวจเพิ่ม"}</span><span>Repair passes: {plan.validation?.repaired_responses || 0}</span><button type="button" onClick={() => void saveProject()} disabled={Boolean(busy)}>Save Edited Shot Plan</button></div>
            </section>
          </>}
        </div>
      </div>
    </div>
  );
}
