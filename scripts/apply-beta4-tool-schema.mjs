import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] || process.cwd());
const path = resolve(appDir, "lib", "agent-tools.ts");
let source = await fs.readFile(path, "utf8");
const marker = "alpha-beta4-tool-schema-v1";
if (source.includes(marker)) process.exit(0);

const webNeedle = `  {\n    type: "function",\n    function: {\n      name: "web_search",`;
if (!source.includes(webNeedle)) throw new Error("หา web_search schema ไม่พบ");
const batchTool = `  // ${marker}\n  {\n    type: "function",\n    function: {\n      name: "install_packages",\n      description: "Install multiple missing Homebrew formulas in one approval. Prefer this when the current workflow needs two or more missing packages so the user is asked once, not once per package.",\n      parameters: {\n        type: "object",\n        required: ["packages"],\n        properties: {\n          packages: { type: "array", minItems: 1, maxItems: 8, items: { type: "string" } },\n          reason: { type: "string", description: "Short reason these packages are needed for the current task" },\n        },\n      },\n    },\n  },\n`;
source = source.replace(webNeedle, `${batchTool}${webNeedle}`);

source = source.replace(
  `  install_package: "กำลังเตรียมติดตั้งโปรแกรมที่ขาด",`,
  `  install_package: "กำลังเตรียมติดตั้งโปรแกรมที่ขาด",\n  install_packages: "กำลังเตรียม dependency ที่ขาดทั้งหมด",`,
);

source = source.replace(
  `- ถ้าขาดโปรแกรม Homebrew formula ที่จำเป็น ให้เรียก install_package เองพร้อมเหตุผล แทนการโยนคำสั่ง brew install ให้ผู้ใช้ไปทำเอง การติดตั้งจะถูกตรวจและขออนุมัติผ่าน UI โดย Tool Service`,
  `- ถ้าขาด Homebrew formula ให้ติดตั้งเองผ่าน tool แทนการโยนคำสั่งให้ผู้ใช้ ถ้าขาดตั้งแต่ 2 รายการขึ้นไปให้รวบรวม dependency ที่จำเป็นต่อ workflow แล้วเรียก install_packages เพื่อขออนุญาตเพียงครั้งเดียว; ใช้ install_package เฉพาะกรณีขาดรายการเดียว`,
);
source = source.replace(
  `- เมื่อ install_package สำเร็จ ให้เรียก system_capability อีกครั้งเพื่อยืนยันว่าคำสั่งพร้อมใช้ แล้วทำงานเดิมต่อโดยอัตโนมัติ`,
  `- หลัง install_package/install_packages สำเร็จ ให้เรียก system_capability อีกครั้ง แล้วทำ workflow เดิมต่อเอง ห้ามหยุดตอบเพียงว่า “ติดตั้งแล้ว” และห้ามให้ผู้ใช้พิมพ์ “ทำต่อ”`,
);
source = source.replace(
  `- อย่าแต่งผลลัพธ์ของเครื่องมือหรืออ้างว่าทำสำเร็จถ้าไม่มีผลลัพธ์ยืนยัน`,
  `- งานที่ผู้ใช้สั่งให้ลงมือเป็น workflow ต้องทำต่อจนได้ผลลัพธ์สุดท้าย, ต้องรอ approval, หรือเจอ blocker จริง ห้ามหยุดกลางทางเพื่อบอกว่าจะทำขั้นถัดไป\n- ถ้าสร้างไฟล์สำเร็จ ต้องอ้าง path จาก Artifact ที่ tool ส่งกลับ ห้ามเดาตำแหน่งไฟล์จาก working directory\n- อย่าแต่งผลลัพธ์ของเครื่องมือหรืออ้างว่าทำสำเร็จถ้าไม่มีผลลัพธ์ยืนยัน`,
);

const tmp = `${path}.beta4.tmp`;
await fs.writeFile(tmp, source, "utf8");
await fs.rename(tmp, path);
console.log("Applied beta4 tool schema");
