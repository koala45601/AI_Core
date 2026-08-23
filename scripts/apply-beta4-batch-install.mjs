import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] || process.cwd());
const wrapperPath = resolve(appDir, "tool-service", "server-wrapper-beta3.mjs");
let source = await fs.readFile(wrapperPath, "utf8");
const marker = "alpha-beta4-batch-install-v1";

if (source.includes(marker)) {
  console.log("Alpha beta4 batch-install patch already applied");
  process.exit(0);
}

const installEndNeedle = `function virtualWirelessSkill() {`;
if (!source.includes(installEndNeedle)) throw new Error("หา virtualWirelessSkill ไม่พบ");

const batchBlock = `// ${marker}
function validateFormulaList(values) {
  const list = Array.isArray(values) ? values : [];
  const formulas = [...new Set(list.map(validateFormula))].slice(0, 8);
  if (!formulas.length) throw new Error("ต้องระบุ package อย่างน้อย 1 รายการ");
  return formulas;
}

async function queueBatchInstallConfirmation(packages, reason) {
  const now = Date.now();
  const key = packages.slice().sort().join("|");
  for (const [id, item] of pending) {
    const existingKey = item.type === "install_packages" && Array.isArray(item.args?.packages)
      ? item.args.packages.slice().sort().join("|") : "";
    if (existingKey === key && ["pending", "running"].includes(String(item.status))) {
      item.updatedAt = now;
      item.expiresAt = now + CONFIRMATION_TTL_MS;
      await persistPending();
      return id;
    }
  }
  const id = randomUUID();
  pending.set(id, {
    type: "install_packages",
    args: { packages, reason },
    status: "pending",
    createdAt: now,
    updatedAt: now,
    expiresAt: now + CONFIRMATION_TTL_MS,
    cachedResult: null,
  });
  await persistPending();
  return id;
}

async function installPackages(args, approved = false) {
  const packages = validateFormulaList(args.packages);
  const reason = String(args.reason || "จำเป็นสำหรับงานปัจจุบัน").trim().slice(0, 500);
  const brew = await brewPath();
  if (!brew) return {
    ok: false,
    package_manager_missing: true,
    manager: "homebrew",
    message: "ยังไม่พบ Homebrew ใน Mac จึงยังติดตั้ง formula ไม่ได้",
    resume: false,
  };

  const missing = [];
  const versions = {};
  for (const formula of packages) {
    const installed = await installedFormula(brew, formula);
    if (installed) versions[formula] = installed;
    else missing.push(formula);
  }
  if (!missing.length) return {
    ok: true,
    already_installed: true,
    packages,
    versions,
    manager: "homebrew",
    message: `ตรวจแล้ว dependency ครบ ${packages.length} รายการ`,
    resume: true,
    resume_prompt: "dependency ที่ต้องใช้มีครบแล้ว ให้ตรวจ capability ใหม่และดำเนินงานเดิมต่อทันที",
  };

  for (const formula of missing) {
    const info = await run(brew, ["info", "--json=v2", formula], {
      timeout: 60_000,
      allowFailure: true,
      env: { HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ENV_HINTS: "1" },
    });
    if (info.code !== 0) throw new Error(`ไม่พบ Homebrew formula '${formula}'`);
  }

  if (!approved) {
    const id = await queueBatchInstallConfirmation(missing, reason);
    return {
      ok: false,
      confirmation_required: true,
      confirmation_id: id,
      expires_at: pending.get(id)?.expiresAt,
      summary: `ต้องติดตั้ง ${missing.join(", ")} เพื่อ${reason} — อนุญาตติดตั้งทั้งหมดครั้งเดียวหรือไม่?`,
      packages: missing,
      manager: "homebrew",
    };
  }

  const startedAt = Date.now();
  const result = await run(brew, ["install", ...missing], {
    timeout: 30 * 60_000,
    allowFailure: true,
    env: { HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ENV_HINTS: "1", NONINTERACTIVE: "1" },
  });
  const verified = {};
  for (const formula of missing) verified[formula] = await installedFormula(brew, formula);
  const failed = missing.filter((formula) => !verified[formula]);
  const logPath = resolve(installLogDir, `${startedAt}-batch-${missing.join("_").replace(/[^a-z0-9_.@+-]/g, "_")}.log`);
  await fs.writeFile(logPath, [result.stdout, result.stderr].filter(Boolean).join("\\n"), "utf8").catch(() => {});
  if (result.code !== 0 || failed.length) return {
    ok: false,
    packages: missing,
    installed: Object.entries(verified).filter(([, version]) => Boolean(version)).map(([name]) => name),
    failed,
    manager: "homebrew",
    message: `ติดตั้ง dependency ไม่ครบ: ${failed.join(", ") || "Homebrew returned an error"}`,
    error: result.stderr.trim().split("\\n").slice(-8).join("\\n") || "Homebrew batch install failed",
    log_path: logPath,
    resume: false,
  };
  return {
    ok: true,
    packages: missing,
    versions: verified,
    manager: "homebrew",
    message: `ติดตั้ง dependency สำเร็จ ${missing.length} รายการ: ${missing.join(", ")}`,
    log_path: logPath,
    resume: true,
    resume_prompt: "ติดตั้ง dependency ที่ขาดทั้งหมดสำเร็จแล้ว ให้ตรวจ system_capability ใหม่ จากนั้นดำเนินงานเดิมต่ออัตโนมัติจนจบหรือจนพบ approval/ข้อจำกัดใหม่ที่จำเป็นจริง",
  };
}

`;
source = source.replace(installEndNeedle, `${batchBlock}${installEndNeedle}`);

const executeNeedle = `      if (name === "system_capability") return json(response, 200, await systemCapability(body.arguments || {}));
      if (name === "install_package") {`;
const executeReplacement = `      if (name === "system_capability") return json(response, 200, await systemCapability(body.arguments || {}));
      if (name === "install_packages") {
        const result = await installPackages(body.arguments || {}, false);
        return json(response, result.confirmation_required ? 409 : 200, result);
      }
      if (name === "install_package") {`;
if (!source.includes(executeNeedle)) throw new Error("หา install_package execute route ไม่พบ");
source = source.replace(executeNeedle, executeReplacement);

const confirmNeedle = `    const result = item.type === "install_package"
      ? await installPackage(item.args || {}, true, id)
      : { ok: false, error: "confirmation type ไม่รู้จัก", resume: false };`;
const confirmReplacement = `    const result = item.type === "install_package"
      ? await installPackage(item.args || {}, true, id)
      : item.type === "install_packages"
        ? await installPackages(item.args || {}, true)
        : { ok: false, error: "confirmation type ไม่รู้จัก", resume: false };`;
if (!source.includes(confirmNeedle)) throw new Error("หา confirmation dispatch ไม่พบ");
source = source.replace(confirmNeedle, confirmReplacement);

const temporary = `${wrapperPath}.beta4.tmp`;
await fs.writeFile(temporary, source, "utf8");
await fs.rename(temporary, wrapperPath);
console.log("Applied Alpha beta4 batch dependency install patch");
