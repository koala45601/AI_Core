import { requestChatOnce } from "@/lib/ollama";
import { AppSettings } from "@/lib/types";
import { CreateVideoProject } from "@/lib/create-video-store";

export interface DirectorCharacter {
  character_id: string;
  name: string;
  identity: {
    age?: number | null;
    face_description: string;
    hair: string;
    body_type: string;
    distinctive_features: string[];
  };
  default_outfit: Record<string, string>;
  states: Array<{ state_id: string; label: string; description: string }>;
}

export interface DirectorLocation {
  location_id: string;
  name: string;
  architecture: string;
  lighting: string;
  weather: string;
  time: string;
  color_palette: string;
  damage_state: string;
}

export interface DirectorScene {
  scene_id: string;
  title: string;
  summary: string;
  location_id: string;
  character_ids: string[];
  duration_seconds: number;
  story_beat: string;
  transformation_notes: string;
}

export interface DirectorShot {
  shot_id: string;
  scene_id: string;
  duration: number;
  location_id: string;
  character_ids: string[];
  character_states: Record<string, string>;
  action: string;
  camera: { shot_type: string; angle: string; movement: string };
  video_prompt: string;
  negative_prompt: string;
  dialogue: string[];
  voiceover: string[];
  sfx: string[];
  continuity_before: Record<string, unknown>;
  continuity_after: Record<string, unknown>;
}

export interface DirectorPlan {
  schema_version: "create-video-phase1-v1";
  project_id: string;
  title: string;
  duration_seconds: number;
  visual_style: Record<string, unknown>;
  story_summary: string;
  story_beats: string[];
  transformation_timeline: string[];
  characters: DirectorCharacter[];
  locations: DirectorLocation[];
  scenes: DirectorScene[];
  shots: DirectorShot[];
  validation: {
    total_shot_duration: number;
    target_duration: number;
    continuity_checked: boolean;
    invalid_character_refs: string[];
    invalid_location_refs: string[];
    repaired_responses: number;
  };
}

function cleanText(value: unknown, max = 2_000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function cleanStringArray(value: unknown, maxItems = 50, maxText = 500) {
  return Array.isArray(value) ? value.map((item) => cleanText(item, maxText)).filter(Boolean).slice(0, maxItems) : [];
}

function cleanRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeId(value: unknown, fallback: string) {
  const cleaned = cleanText(value, 100).toUpperCase().replace(/[^A-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || fallback;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try { return JSON.parse(unfenced); } catch { /* try object slice */ }
  const first = unfenced.indexOf("{");
  const last = unfenced.lastIndexOf("}");
  if (first >= 0 && last > first) return JSON.parse(unfenced.slice(first, last + 1));
  throw new Error("Director ตอบกลับไม่ใช่ JSON ที่ parse ได้");
}

async function requestStructured(
  label: string,
  system: string,
  user: string,
  settings: AppSettings,
  validate: (value: unknown) => boolean,
): Promise<{ value: Record<string, unknown>; repaired: boolean }> {
  const first = await requestChatOnce([
    { role: "system", content: `${system}\nตอบ JSON object เท่านั้น ห้าม markdown ห้ามอธิบายนอก JSON` },
    { role: "user", content: user },
  ], settings, 0.15);
  try {
    const parsed = extractJson(first.content);
    if (validate(parsed)) return { value: parsed as Record<string, unknown>, repaired: false };
    throw new Error(`${label} schema ไม่ครบ`);
  } catch {
    const repaired = await requestChatOnce([
      {
        role: "system",
        content: `คุณเป็น JSON repair pass สำหรับ ${label}. แก้ข้อมูลให้เป็น JSON object ตาม schema ที่ผู้ใช้ระบุ ห้ามเพิ่มคำอธิบาย ห้าม markdown และห้ามเปลี่ยนสาระโดยไม่จำเป็น`,
      },
      { role: "user", content: `Schema/requirements:\n${system}\n\nค่าที่ต้องซ่อม:\n${first.content.slice(0, 24_000)}` },
    ], settings, 0);
    const parsed = extractJson(repaired.content);
    if (!validate(parsed)) throw new Error(`${label} ยังไม่ผ่าน schema หลัง Repair Pass`);
    return { value: parsed as Record<string, unknown>, repaired: true };
  }
}

function storySchemaValid(value: unknown) {
  const root = cleanRecord(value);
  return Boolean(cleanText(root.story_summary, 100) && Array.isArray(root.characters) && Array.isArray(root.locations) && Array.isArray(root.scenes));
}

function shotSchemaValid(value: unknown) {
  const root = cleanRecord(value);
  return Array.isArray(root.shots) && root.shots.length > 0;
}

function normalizeCharacters(value: unknown): DirectorCharacter[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 40).map((item, index) => {
    const row = cleanRecord(item);
    const identity = cleanRecord(row.identity);
    const statesRaw = Array.isArray(row.states) ? row.states : [];
    const characterId = safeId(row.character_id, `CHAR_${String(index + 1).padStart(3, "0")}`);
    return {
      character_id: characterId,
      name: cleanText(row.name, 120) || characterId,
      identity: {
        age: Number.isFinite(Number(identity.age)) ? Math.max(0, Math.round(Number(identity.age))) : null,
        face_description: cleanText(identity.face_description, 500),
        hair: cleanText(identity.hair, 300),
        body_type: cleanText(identity.body_type, 300),
        distinctive_features: cleanStringArray(identity.distinctive_features, 20, 180),
      },
      default_outfit: Object.fromEntries(Object.entries(cleanRecord(row.default_outfit)).slice(0, 20).map(([key, val]) => [key, cleanText(val, 180)]).filter(([, val]) => val)),
      states: statesRaw.slice(0, 20).map((state, stateIndex) => {
        const record = cleanRecord(state);
        return {
          state_id: safeId(record.state_id, `${characterId}_STATE_${stateIndex + 1}`),
          label: cleanText(record.label, 120) || `State ${stateIndex + 1}`,
          description: cleanText(record.description, 500),
        };
      }),
    };
  });
}

function normalizeLocations(value: unknown): DirectorLocation[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 60).map((item, index) => {
    const row = cleanRecord(item);
    const locationId = safeId(row.location_id, `LOCATION_${String(index + 1).padStart(3, "0")}`);
    return {
      location_id: locationId,
      name: cleanText(row.name, 160) || locationId,
      architecture: cleanText(row.architecture, 500),
      lighting: cleanText(row.lighting, 300),
      weather: cleanText(row.weather, 160),
      time: cleanText(row.time, 160),
      color_palette: cleanText(row.color_palette, 300),
      damage_state: cleanText(row.damage_state, 300),
    };
  });
}

function normalizeScenes(value: unknown, duration: number, locationIds: Set<string>, characterIds: Set<string>): DirectorScene[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [{ scene_id: "SCENE_001", title: "Main Scene", summary: "Main story progression", location_id: [...locationIds][0] || "LOCATION_001", character_ids: [...characterIds].slice(0, 4), duration_seconds: duration, story_beat: "main", transformation_notes: "" }];
  }
  const scenes = value.slice(0, 30).map((item, index) => {
    const row = cleanRecord(item);
    const requestedLocation = safeId(row.location_id, "");
    return {
      scene_id: safeId(row.scene_id, `SCENE_${String(index + 1).padStart(3, "0")}`),
      title: cleanText(row.title, 160) || `Scene ${index + 1}`,
      summary: cleanText(row.summary, 1_200),
      location_id: locationIds.has(requestedLocation) ? requestedLocation : [...locationIds][0] || "LOCATION_001",
      character_ids: cleanStringArray(row.character_ids, 20, 100).map((id) => safeId(id, "")).filter((id) => characterIds.has(id)),
      duration_seconds: Math.max(2, Math.round(Number(row.duration_seconds || 0))),
      story_beat: cleanText(row.story_beat, 500),
      transformation_notes: cleanText(row.transformation_notes, 500),
    };
  });
  const total = scenes.reduce((sum, scene) => sum + scene.duration_seconds, 0) || scenes.length;
  let remaining = duration;
  return scenes.map((scene, index) => {
    const isLast = index === scenes.length - 1;
    const scaled = isLast ? remaining : Math.max(2, Math.round(duration * (scene.duration_seconds / total)));
    const seconds = Math.max(2, Math.min(remaining - Math.max(0, scenes.length - index - 1) * 2, scaled));
    remaining -= seconds;
    return { ...scene, duration_seconds: index === scenes.length - 1 ? Math.max(2, seconds + remaining) : seconds };
  });
}

function normalizeShots(
  value: unknown,
  scene: DirectorScene,
  globalStartIndex: number,
  characterIds: Set<string>,
  locationIds: Set<string>,
  fallbackNegative: string,
): DirectorShot[] {
  const raw = Array.isArray(value) ? value : [];
  const countFallback = Math.max(1, Math.round(scene.duration_seconds / 7));
  const source = raw.length ? raw : Array.from({ length: countFallback }, (_, index) => ({ action: `${scene.summary} beat ${index + 1}` }));
  const shots = source.slice(0, 80).map((item, index) => {
    const row = cleanRecord(item);
    const camera = cleanRecord(row.camera);
    const requestedLocation = safeId(row.location_id, scene.location_id);
    const stateSource = cleanRecord(row.character_states);
    const characterStates = Object.fromEntries(Object.entries(stateSource).map(([key, val]) => [safeId(key, ""), cleanText(val, 120)]).filter(([key]) => characterIds.has(key)));
    return {
      shot_id: `SHOT_${String(globalStartIndex + index + 1).padStart(3, "0")}`,
      scene_id: scene.scene_id,
      duration: Math.max(2, Math.min(12, Math.round(Number(row.duration || 7)))),
      location_id: locationIds.has(requestedLocation) ? requestedLocation : scene.location_id,
      character_ids: cleanStringArray(row.character_ids, 20, 100).map((id) => safeId(id, "")).filter((id) => characterIds.has(id)),
      character_states: characterStates,
      action: cleanText(row.action, 800) || scene.summary,
      camera: {
        shot_type: cleanText(camera.shot_type, 120) || "medium",
        angle: cleanText(camera.angle, 120) || "eye-level",
        movement: cleanText(camera.movement, 160) || "static",
      },
      video_prompt: cleanText(row.video_prompt, 2_000) || `${scene.summary}. ${cleanText(row.action, 800)}`,
      negative_prompt: cleanText(row.negative_prompt, 1_000) || fallbackNegative,
      dialogue: cleanStringArray(row.dialogue, 20, 500),
      voiceover: cleanStringArray(row.voiceover, 20, 500),
      sfx: cleanStringArray(row.sfx, 20, 300),
      continuity_before: cleanRecord(row.continuity_before),
      continuity_after: cleanRecord(row.continuity_after),
    };
  });
  return fitShotsToDuration(shots, scene.duration_seconds);
}

function fitShotsToDuration(shots: DirectorShot[], target: number): DirectorShot[] {
  if (!shots.length) return shots;
  let total = shots.reduce((sum, shot) => sum + shot.duration, 0);
  let guard = 0;
  while (total !== target && guard < 10_000) {
    guard += 1;
    const grow = total < target;
    let changed = false;
    for (const shot of shots) {
      if (grow && shot.duration < 12) { shot.duration += 1; total += 1; changed = true; }
      else if (!grow && shot.duration > 2) { shot.duration -= 1; total -= 1; changed = true; }
      if (total === target) break;
    }
    if (!changed) break;
  }
  if (total < target) {
    let remaining = target - total;
    while (remaining > 0) {
      const last = shots[shots.length - 1];
      const duration = Math.min(12, Math.max(2, remaining));
      shots.push({ ...last, shot_id: `SHOT_${String(shots.length + 1).padStart(3, "0")}`, duration, action: `${last.action} continuation`, dialogue: [], voiceover: [], sfx: [], continuity_before: { ...last.continuity_after }, continuity_after: { ...last.continuity_after } });
      remaining -= duration;
    }
  }
  return shots;
}

function applyContinuity(shots: DirectorShot[]) {
  let previous: Record<string, unknown> = {};
  for (const shot of shots) {
    shot.continuity_before = { ...previous, ...shot.continuity_before };
    shot.continuity_after = { ...shot.continuity_before, ...shot.continuity_after };
    previous = shot.continuity_after;
  }
}

export async function planCreateVideoProject(project: CreateVideoProject, settings: AppSettings): Promise<DirectorPlan> {
  const storyInput = project.screenplay || project.story;
  if (!storyInput.trim()) throw new Error("Project ไม่มี Story/Screenplay สำหรับ Director");
  let repairedResponses = 0;
  const storyPass = await requestStructured(
    "Story Planner",
    `คุณคือ AI Director สำหรับ Local AI Film Studio บน MacBook M4 16GB. ทำ PASS 1 เท่านั้น: วิเคราะห์เรื่องทั้งเรื่องก่อนแตกช็อต.
JSON schema:
{
  "story_summary":"...",
  "story_beats":["..."],
  "transformation_timeline":["..."],
  "characters":[{"character_id":"RIN_001","name":"Rin","identity":{"age":23,"face_description":"","hair":"","body_type":"","distinctive_features":[]},"default_outfit":{},"states":[{"state_id":"RIN_001_HUMAN","label":"HUMAN","description":""}]}],
  "locations":[{"location_id":"CITY_001","name":"","architecture":"","lighting":"","weather":"","time":"","color_palette":"","damage_state":""}],
  "scenes":[{"scene_id":"SCENE_001","title":"","summary":"","location_id":"CITY_001","character_ids":["RIN_001"],"duration_seconds":20,"story_beat":"","transformation_notes":""}]
}
กฎ: ใช้ Global ID คงที่, ห้ามสุ่มคำอธิบายตัวละครใหม่ในแต่ละ scene, รวม duration ของ scenes ให้ใกล้ ${project.target_duration_seconds} วินาที, อย่าเขียน shots ใน pass นี้.`,
    `Project: ${project.name}\nTarget duration: ${project.target_duration_seconds}s\nVisual: ${JSON.stringify(project.visual)}\n\nStory/Screenplay:\n${storyInput.slice(0, 36_000)}`,
    settings,
    storySchemaValid,
  );
  if (storyPass.repaired) repairedResponses += 1;
  let characters = normalizeCharacters(storyPass.value.characters);
  let locations = normalizeLocations(storyPass.value.locations);
  if (!characters.length) characters = [];
  if (!locations.length) locations = [{ location_id: "LOCATION_001", name: "Primary Location", architecture: "", lighting: "", weather: "", time: "", color_palette: "", damage_state: "" }];
  const characterIds = new Set(characters.map((item) => item.character_id));
  const locationIds = new Set(locations.map((item) => item.location_id));
  const scenes = normalizeScenes(storyPass.value.scenes, project.target_duration_seconds, locationIds, characterIds);

  const shots: DirectorShot[] = [];
  let previousShotSummary = "ไม่มีช็อตก่อนหน้า";
  for (const scene of scenes) {
    const relevantCharacters = characters.filter((character) => scene.character_ids.includes(character.character_id));
    const location = locations.find((item) => item.location_id === scene.location_id) || locations[0];
    const expectedShots = Math.max(1, Math.round(scene.duration_seconds / 7));
    const shotPass = await requestStructured(
      `Shot Planner ${scene.scene_id}`,
      `คุณคือ AI Director PASS 2. แตกเฉพาะ scene ปัจจุบันเป็น shots สำหรับ Local Video Model; อย่าอ่าน screenplay เต็มซ้ำ.
JSON schema: {"shots":[{"duration":7,"location_id":"${scene.location_id}","character_ids":[],"character_states":{},"action":"","camera":{"shot_type":"","angle":"","movement":""},"video_prompt":"","negative_prompt":"","dialogue":[],"voiceover":[],"sfx":[],"continuity_before":{},"continuity_after":{}}]}
กฎ: สร้างประมาณ ${expectedShots} shots, แต่ละ shot 2-12 วินาที, รวมใกล้ ${scene.duration_seconds}s, ใช้ Character/Location IDs ที่ให้เท่านั้น, continuity ต้องต่อจาก previous shot, prompt ต้องบอก subject/action/camera/location/lighting โดยไม่เปลี่ยน identity เอง.`,
      `GLOBAL STORY SUMMARY:\n${cleanText(storyPass.value.story_summary, 4_000)}\n\nSCENE:\n${JSON.stringify(scene)}\n\nCHARACTERS:\n${JSON.stringify(relevantCharacters)}\n\nLOCATION:\n${JSON.stringify(location)}\n\nPREVIOUS SHOT SUMMARY:\n${previousShotSummary}\n\nPROJECT VISUAL:\n${JSON.stringify(project.visual)}`,
      settings,
      shotSchemaValid,
    );
    if (shotPass.repaired) repairedResponses += 1;
    const sceneShots = normalizeShots(shotPass.value.shots, scene, shots.length, characterIds, locationIds, project.visual.negative_prompt);
    for (const shot of sceneShots) shots.push(shot);
    const last = sceneShots[sceneShots.length - 1];
    previousShotSummary = last ? `${last.shot_id}: ${last.action}; state=${JSON.stringify(last.continuity_after)}`.slice(0, 2_000) : previousShotSummary;
  }

  applyContinuity(shots);
  shots.forEach((shot, index) => { shot.shot_id = `SHOT_${String(index + 1).padStart(3, "0")}`; });
  const invalidCharacterRefs = [...new Set(shots.flatMap((shot) => shot.character_ids.filter((id) => !characterIds.has(id))))];
  const invalidLocationRefs = [...new Set(shots.map((shot) => shot.location_id).filter((id) => !locationIds.has(id)))];
  const totalShotDuration = shots.reduce((sum, shot) => sum + shot.duration, 0);
  return {
    schema_version: "create-video-phase1-v1",
    project_id: project.id,
    title: project.name,
    duration_seconds: project.target_duration_seconds,
    visual_style: project.visual,
    story_summary: cleanText(storyPass.value.story_summary, 8_000),
    story_beats: cleanStringArray(storyPass.value.story_beats, 100, 600),
    transformation_timeline: cleanStringArray(storyPass.value.transformation_timeline, 100, 600),
    characters,
    locations,
    scenes,
    shots,
    validation: {
      total_shot_duration: totalShotDuration,
      target_duration: project.target_duration_seconds,
      continuity_checked: invalidCharacterRefs.length === 0 && invalidLocationRefs.length === 0,
      invalid_character_refs: invalidCharacterRefs,
      invalid_location_refs: invalidLocationRefs,
      repaired_responses: repairedResponses,
    },
  };
}
