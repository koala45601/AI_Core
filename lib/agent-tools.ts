export const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "create_files",
      description: "Create a real code/text project under /Volumes/petong/Disk/AI/Program_Create/<unique-project-name>. Existing folders are preserved and a numeric suffix is added automatically. Always use this for a new file or project; never merely paste it as chat text.",
      parameters: {
        type: "object",
        required: ["project_name", "files"],
        properties: {
          project_name: { type: "string", description: "Short safe project name" },
          destination: { type: "string", description: "Optional absolute destination explicitly requested by the user" },
          zip: { type: "boolean", description: "Create a zip archive; use true for multi-file projects" },
          files: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            items: {
              type: "object",
              required: ["path", "content"],
              properties: {
                path: { type: "string", description: "Relative path including a supported extension" },
                content: { type: "string", description: "Complete UTF-8 file content" },
              },
            },
          },
        },
      },
    },
  },
  // alpha-beta6-host-filesystem-v1
  {
    type: "function",
    function: {
      name: "host_fs",
      description: "Read-only inspection of files and directories on the macOS host. Use this for file existence, path verification, stat/metadata, directory listing, and real read/write/create access checks. This tool never launches Docker or Skill Lab.",
      parameters: {
        type: "object",
        required: ["action", "path"],
        properties: {
          action: { type: "string", enum: ["exists", "stat", "list", "access"] }, // alpha-beta12-host-access-routing-v1
          path: { type: "string", description: "Absolute macOS host path to inspect" },
          max_entries: { type: "number", description: "Maximum directory entries for list; defaults to 100 and caps at 200" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "manage_file",
      description: "Read, replace, move, zip, reveal in Finder, or delete a real file. Delete always moves the item to macOS Trash and always requires confirmation.",
      parameters: {
        type: "object",
        required: ["action"],
        properties: {
          action: { type: "string", enum: ["read", "edit", "move", "zip", "open_finder", "delete"] },
          artifact_id: { type: "string", description: "Artifact ID from a previous tool result" },
          path: { type: "string", description: "Absolute path when there is no artifact ID" },
          destination: { type: "string", description: "Absolute destination for move" },
          content: { type: "string", description: "Complete replacement content for edit" },
          zip_name: { type: "string", description: "Archive name for zip" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "system_capability",
      description: "Inspect the current Mac before claiming hardware, driver, package, or permission is missing. Use this first for local development, Wi-Fi/security lab, build tools, runtimes, or any request that may depend on installed software or Mac hardware.",
      parameters: {
        type: "object",
        properties: {
          area: { type: "string", enum: ["general", "development", "wifi", "security"], description: "Capability area to inspect" },
          commands: {
            type: "array",
            maxItems: 20,
            items: { type: "string" },
            description: "Optional executable names to check, for example git, python3, aircrack-ng, hcxdumptool",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "install_packages",
      description: "Install multiple missing Homebrew formulas with one approval. Inspect capability first, collect all known missing formulas for the current task, and prefer this tool instead of interrupting the user for one package at a time.",
      parameters: {
        type: "object",
        required: ["packages"],
        properties: {
          packages: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: { type: "string" },
            description: "Homebrew formula names only; no shell syntax, URLs, taps, casks, or options",
          },
          reason: { type: "string", description: "Short explanation of why this dependency set is required" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "install_package",
      description: "Install one missing Homebrew formula on the user's Mac. Prefer install_packages when more than one dependency is already known. The Tool Service validates the formula and requests approval before changing the Mac.",
      parameters: {
        type: "object",
        required: ["package"],
        properties: {
          package: { type: "string", description: "Homebrew formula name only, without shell syntax, URL, tap, cask, or options" },
          reason: { type: "string", description: "Short explanation of why this package is needed for the current task" },
        },
      },
    },
  },
  // alpha-beta4-tool-schema-v1
  {
    type: "function",
    function: {
      name: "install_packages",
      description: "Install multiple missing Homebrew formulas in one approval. Prefer this when the current workflow needs two or more missing packages so the user is asked once, not once per package.",
      parameters: {
        type: "object",
        required: ["packages"],
        properties: {
          packages: { type: "array", minItems: 1, maxItems: 8, items: { type: "string" } },
          reason: { type: "string", description: "Short reason these packages are needed for the current task" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the live web with local SearXNG. Use for current, obscure, or explicitly requested online information.",
      parameters: { type: "object", required: ["query"], properties: { query: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "web_read",
      description: "Read the text of a public HTTP/HTTPS webpage or PDF after a search or when the user provides a URL.",
      parameters: { type: "object", required: ["url"], properties: { url: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_action",
      description: "Control the selected browser mode. Use only when the user asks to open or interact with a website, not for ordinary fact lookup.",
      parameters: {
        type: "object",
        required: ["action"],
        properties: {
          action: { type: "string", enum: ["open", "snapshot", "inspect_events", "inspect_form", "click", "type", "scroll", "download", "upload", "submit"] },
          url: { type: "string" }, selector: { type: "string" }, text: { type: "string" }, y: { type: "number" },
          file_path: { type: "string", description: "Absolute local path for upload" },
          new_tab: { type: "boolean", description: "Open a new tab; defaults to true" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "api_discovery",
      description: "Discover and test website APIs. Passive fetch/XHR capture and GET/HEAD/OPTIONS work on public sites; mutating replay works without repeated confirmation for domains the user placed in Active Test Domains. Secrets are always redacted from logs.",
      parameters: {
        type: "object",
        required: ["action", "url"],
        properties: {
          action: { type: "string", enum: ["discover", "observe_existing", "probe"] },
          url: { type: "string" },
          observe_seconds: { type: "number", description: "1-15 seconds for discover" },
          method: { type: "string", enum: ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"] },
          headers: { type: "object", additionalProperties: { type: "string" } },
          body: { type: "object", description: "JSON request body for probe" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_learned_skills",
      description: "List capabilities that Alpha successfully built and tested in Skill Lab. Use this when a request may be handled by a learned skill.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "run_learned_skill",
      description: "Run an installed learned skill. Dual-runtime skills can use macOS host automatically when Full local access is enabled; otherwise they run in Docker sandbox. First use list_learned_skills to get the exact skill_id.",
      parameters: {
        type: "object",
        required: ["skill_id", "input"],
        properties: {
          skill_id: { type: "string" },
          input: { type: "object", description: "Structured input for the learned skill" },
          execution_target: { type: "string", enum: ["auto", "sandbox", "macos_host"], description: "Use auto unless the task explicitly requires isolation or real Mac access" },
        },
      },
    },
  },
  // alpha-beta10-host-execution-v1
  {
    type: "function",
    function: {
      name: "run_host_artifact",
      description: "Run a canonical Alpha workspace artifact directly on the user's macOS host when the task genuinely needs real Mac hardware, local network interfaces, local services, filesystem state, or installed CLI tools. This is not Docker. When Settings uses Full user-file access (`full_user_files`), persistent local authority is already granted and repeated host-action approval is skipped; otherwise this tool requests approval. Do not use it for ordinary unit/syntax tests that belong in run_artifact.",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string", description: "Absolute canonical artifact path under the Alpha workspace" },
          args: { type: "array", maxItems: 32, items: { type: "string" }, description: "Argument array passed directly to the interpreter; never shell syntax" },
          reason: { type: "string", description: "Why this task needs the real Mac host instead of Docker" },
          timeout_seconds: { type: "number", minimum: 1, maximum: 600 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_artifact",
      description: "Run a previously created Python or JavaScript artifact in a network-disabled Docker sandbox. This always requires user confirmation.",
      parameters: { type: "object", required: ["artifact_id"], properties: { artifact_id: { type: "string" } } },
    },
  },
] as const;

export const TOOL_LABELS: Record<string, string> = {
  host_fs: "กำลังตรวจไฟล์บน macOS โดยตรง",
  create_files: "กำลังสร้างไฟล์จริง",
  manage_file: "กำลังจัดการไฟล์",
  system_capability: "กำลังตรวจความสามารถจริงของ Mac",
  install_packages: "กำลังเตรียมติดตั้ง dependency ที่ขาดทั้งหมด",
  install_package: "กำลังเตรียมติดตั้งโปรแกรมที่ขาด",
  install_packages: "กำลังเตรียม dependency ที่ขาดทั้งหมด",
  web_search: "กำลังค้นเว็บด้วย SearXNG",
  web_read: "กำลังอ่านหน้าเว็บ",
  browser_action: "กำลังควบคุมเบราว์เซอร์",
  api_discovery: "กำลังวิเคราะห์ Network และ API ของเว็บทดสอบ",
  list_learned_skills: "กำลังตรวจทักษะที่เรียนแล้ว",
  run_learned_skill: "กำลังใช้ทักษะที่เรียนแล้ว",
  run_host_artifact: "กำลังเตรียมรันงานบน Mac จริง",
  run_artifact: "กำลังเตรียม Docker sandbox",
};

export const TOOL_SYSTEM_INSTRUCTIONS = `
คุณมีเครื่องมือจริงให้ใช้ และเมื่อผู้ใช้สั่งให้ “ทำ” งาน ต้องพยายามทำ workflow ให้จบ ไม่ใช่ตอบเป็นแผนแล้วหยุด:
- เมื่อผู้ใช้ขอสร้าง/บันทึก/ดาวน์โหลดไฟล์หรือโปรเจกต์ ต้องเรียก create_files เสมอ ห้ามตอบเพียง code block แล้วอ้างว่าสร้างไฟล์แล้ว
- โปรแกรมใหม่ทุกโปรแกรมต้องสร้างใน /Volumes/petong/Disk/AI/Program_Create/<ชื่อโปรแกรม>/ โดยไม่ส่ง destination เอง ระบบจะตั้งชื่อโฟลเดอร์ไม่ซ้ำและไม่เขียนทับของเก่า
- งานสร้างโปรแกรมให้พิจารณา Python เป็นตัวเลือกแรก แต่ไม่จำกัดภาษา เฟรมเวิร์ก library runtime หรือการทำโปรเจกต์หลายภาษา; เลือก Java/Swift/JavaScript/TypeScript/Go/Rust และ FastAPI/Django/Flask/React/Next.js/Spring/Electron/Playwright/Selenium หรือเครื่องมืออื่นได้อิสระเมื่อเหมาะกว่า พร้อมสร้าง manifest dependency และ start script ที่ติดตั้งสิ่งที่ขาดไว้เฉพาะในโฟลเดอร์โปรแกรม
- หลัง create_files สำเร็จ ต้องจำ path จากผล tool และบอกตำแหน่งไฟล์จริงในคำตอบ ห้ามเดาพาธ
- alpha-beta8-permission-domains-v1: แยก permission domain ให้ชัด: code_execution_mode="docker" หมายถึงเฉพาะการรันโค้ดผ่าน run_artifact/Skill Lab ไม่ได้หมายความว่าไฟล์ของผู้ใช้หรือ workspace อยู่ใน Docker
- create_files, manage_file และ host_fs เป็นเครื่องมือ macOS host; เมื่อ path อยู่ใน workspace ของ Alpha หรืออยู่ในขอบเขต file_access_mode ให้ทำกับ host โดยตรง ห้ามย้ายไป sandbox เอง
- การสร้างไฟล์และการรันไฟล์เป็นคนละขั้น: create_files ต้องสร้าง canonical Artifact บน host ก่อน; run_artifact เป็นเพียงการรันสำเนา/การ mount ใน sandbox และห้ามเปลี่ยน canonical host path ของ Artifact
- alpha-beta10-host-execution-v1: Sandbox ไม่ใช่สภาพแวดล้อมหลักของอัลฟ่า แต่เป็น isolation domain สำหรับทดสอบโค้ดที่ไม่จำเป็นต้องแตะเครื่องจริงเท่านั้น
- ถ้างานต้องใช้ hardware, Wi-Fi/network interface, local service, installed CLI หรือ filesystem/runtime state ของ Mac จริง ให้ใช้ run_host_artifact หลังสร้าง Artifact บน host และขออนุญาตผู้ใช้ ห้ามสรุปว่างานทำจริงไม่ได้เพียงเพราะ run_artifact เป็น Docker
- run_host_artifact และ run_artifact เป็นคนละ execution domain: งานทดสอบโค้ดทั่วไป -> Docker; งานที่ต้อง interact กับ Mac จริง -> macOS host หลัง approval
- alpha-beta11-full-host-permission-v1: ถ้า file_access_mode=full_user_files ให้ถือว่าเป็น persistent Full local permission สำหรับ host actions ที่ผ่าน validation แล้ว: run_host_artifact และ install_package/install_packages ทำต่อได้ทันทีโดยไม่สร้าง approval ซ้ำ
- Full permission ไม่ยกเลิกขอบเขตความปลอดภัยของระบบ: ยังต้องบล็อก .git, .env*, .dev.vars, macOS system roots, symlink escape, invalid artifact, invalid package/formula และ security target ที่อยู่นอก scope
- ถ้าไม่ใช่ full_user_files ให้ใช้ approval flow เดิม และแสดง WAITING_APPROVAL ให้ชัดเจน
- ห้ามใช้ run_host_artifact เพื่อเช็คว่าไฟล์มีอยู่ไหมหรือดู path; งาน metadata ใช้ host_fs โดยตรง และงาน package ใช้ install_package/install_packages
- งาน security/network ที่ผู้ใช้ยืนยันว่าเป็นระบบหรือ lab ของตนเอง สามารถใช้ host-native execution เมื่อจำเป็นต่อ hardware/local interface จริง แต่ต้องคง target scope ที่ได้รับอนุญาตและอ้างผลจากเครื่องมือจริงเท่านั้น
- ห้ามสรุปว่าไม่มีสิทธิ์เขียนไฟล์บน Mac เพียงเพราะ execution mode เป็น Docker; ต้องใช้ผล create_files/host_fs/file_access_mode เป็นข้อเท็จจริงเท่านั้น
- เมื่อผู้ใช้ถามว่าไฟล์/โฟลเดอร์มีจริงไหม, เช็ค path, หาไฟล์ไม่เจอ, ตรวจ metadata หรือขอดูรายการไฟล์ ต้องใช้ host_fs บน macOS host โดยตรง ห้ามใช้ run_artifact, run_learned_skill, Skill Lab หรือ Docker สำหรับงานตรวจ filesystem metadata
- ถ้า host_fs คืน exists=false ให้รายงาน NOT_FOUND ตามจริง ห้ามเดาว่า External Drive หลุด; ถ้า path อยู่ใต้ appDir ที่ Alpha กำลังรันอยู่ ให้ถือว่า storage state ต้องยืนยันจาก host tool เท่านั้น
- alpha-beta12-host-access-routing-v1: คำถามเรื่องการเข้าถึง/read/write/permission/create capability ของ /Volumes/... หรือ /Users/... ต้องเชื่อผล host_fs action=access เท่านั้น; ห้ามอ้างว่า Sandbox/Docker ทำให้แตะ Host ไม่ได้ถ้า host_fs ยังไม่ได้คืน error จริง
- เมื่อ host_filesystem_ready=true ห้ามบอกให้ผู้ใช้ไปเปิด Terminal เพียงเพื่อเช็ค path/access ที่ host_fs ตรวจได้เอง
- ใช้ manage_file เมื่อผู้ใช้ต้องการอ่าน แก้ ย้าย ZIP เปิดใน Finder หรือลบไฟล์จริง ลบได้เฉพาะเมื่อระบบขอและผู้ใช้ยืนยัน
- ก่อนบอกว่า Mac ขาด hardware, driver, permission, runtime หรือโปรแกรม ต้องเรียก system_capability เพื่อตรวจเครื่องจริงก่อน ห้ามเดาจากข้อจำกัดทั่วไปของแพลตฟอร์ม
- สำหรับ Wi-Fi ให้เริ่มจาก Wi-Fi hardware ที่มีอยู่ใน Mac ก่อนเสมอ ตรวจว่าระบบเปิดความสามารถใดให้ใช้ได้จริง แล้วค่อยสรุปข้อจำกัดจากผลตรวจ ห้ามบังคับให้ซื้อ adapter ภายนอกหรือใช้ Linux/VM ก่อนตรวจของที่มีอยู่
- ถ้างานต้องใช้หลาย dependency ให้ตรวจรายการที่ขาดทั้งหมดก่อน แล้วเรียก install_packages ครั้งเดียวเพื่อขออนุญาตติดตั้งเป็นชุด ห้ามขอทีละ package ถ้ารู้ได้ตั้งแต่ต้นว่าต้องใช้หลายตัว
- ใช้ install_package เฉพาะเมื่อขาดเพียง package เดียวหรือเพิ่งค้นพบ dependency เพิ่มภายหลัง
- หลัง install_packages/install_package สำเร็จ ต้องเรียก system_capability อีกครั้ง แล้วดำเนินงานเดิมต่อทันทีโดยอัตโนมัติ ห้ามหยุดที่ “ติดตั้งเสร็จแล้ว”
- หากขั้นต่อไปใช้เครื่องมือได้ ให้เรียกเครื่องมือต่อเอง ห้ามจบคำตอบด้วย “ถ้าต้องการให้ทำต่อ...” หรือบอกให้ผู้ใช้พิมพ์ “ทำต่อ”
- ถ้าต้องได้รับอนุญาต ให้สร้างคำขออนุญาตทันทีที่รู้ว่าจำเป็น และระบุชัดว่าสถานะคือ WAITING_APPROVAL; อย่าเขียนข้อความให้ดูเหมือนงานเสร็จแล้ว
- เมื่อได้รับอนุญาตแล้ว ให้ resume งานเดิมจากจุดที่ค้างจนถึงผลลัพธ์สุดท้าย, approval ถัดไปที่จำเป็นจริง, หรือข้อผิดพลาด/ข้อจำกัดที่ยืนยันจากเครื่องมือ
- ใช้ web_search สำหรับข้อมูลล่าสุดหรือการค้นเว็บ และ web_read เพื่ออ่านหลักฐานฉบับเต็ม
- ใช้ browser_action เฉพาะเมื่อผู้ใช้ต้องการเปิดหรือควบคุมเว็บไซต์
- ใช้ api_discovery เมื่อผู้ใช้ต้องการหา endpoint/method/schema แบบ DevTools หรือ probe API ของเว็บตนเอง โดเมนต้องอยู่ใน Security Test Domains และห้ามใส่ credential ลง arguments
- เมื่อคำขออาจตรงกับความสามารถที่อัลฟ่าเรียนใน Skill Lab ให้เรียก list_learned_skills และใช้ run_learned_skill ด้วย id ที่มีอยู่จริง
- ผู้ใช้ระบุเป้าหมายปลายทางได้โดยไม่ต้องเลือกวิธี: ให้คุณเลือกและเชื่อมเครื่องมือที่พร้อมเอง เช่น Host Tool → Browser/API discovery → learned skill → Artifact จนได้ผลลัพธ์ที่ตรวจสอบได้
- ถ้า Full local access เปิดอยู่และเครื่องมือไม่คืน WAITING_APPROVAL ให้ทำขั้นถัดไปต่อทันที ห้ามถามผู้ใช้ให้เลือก tool, runtime หรือวิธีดำเนินการแทนคุณ
- สกิล Hacker Lab, System Access และ Cybersecurity เป็นตัววิเคราะห์/แปลงหลักฐานจริง ต้องเก็บข้อมูลที่ต้องใช้จาก host_fs, system_capability, browser_action หรือ api_discovery ก่อน แล้วจึงเรียกสกิล ห้ามสร้าง input หรือผลตรวจขึ้นเอง
- สำหรับสกิล concert-ticket-purchase-assistant อัลฟ่ามีหน้าที่สร้างโปรแกรมและ Full Loop launcher: เปิด URL แล้วเรียก browser_action action=inspect_events ก่อนเสมอ แสดงทุกสถานะที่เว็บไซต์ส่งมา (Open, Upcoming, SOLD OUT, Closed, Ended, Cancelled, Unknown) พร้อมชื่อคอน วันที่แสดง และวันเปิดขาย แต่อนุญาตให้เลือกสร้างได้เฉพาะ Open/Upcoming; หลังผู้ใช้เลือกแล้ว จำนวนบัตรเป็นข้อมูลบังคับ ส่วนรอบ ที่นั่ง/โซน งบ และวิธีชำระที่ยังไม่รู้ให้โปรแกรมค้นหรือถามตอนรันได้ การ inspect_form และ api_discovery เป็นการเพิ่มหลักฐานแต่ห้ามใช้เป็นเงื่อนไขขวางการสร้างเมื่อเว็บบล็อก public inspection; โปรแกรมที่สร้างต้องค้นข้อมูลจริงตอนรัน ล็อกอินจาก environment/secure prompt โดยไม่บันทึกรหัสผ่าน รักษาคิวตาม Retry-After ทำ terms → zone/image-map → quantity → attendee → delivery/payment และค้างที่ CAPTCHA/OTP/QR โดยไม่เก็บ password/OTP ลงความจำ
- ใช้ความสามารถรูปภาพได้เมื่อ image_search_enabled เปิดอยู่และมีเครื่องมือที่ติดตั้งจริง หากยังไม่มีให้รายงานว่า capability ยังไม่พร้อมตามจริง ไม่ใช่อ้างว่าเป็นกฎถาวร
- ถ้าเครื่องมือแจ้ง syntax error ให้แก้เนื้อหาและเรียก create_files ใหม่ได้ไม่เกิน 2 รอบ
- งานที่ผู้ใช้สั่งให้ลงมือเป็น workflow ต้องทำต่อจนได้ผลลัพธ์สุดท้าย, ต้องรอ approval, หรือเจอ blocker จริง ห้ามหยุดกลางทางเพื่อบอกว่าจะทำขั้นถัดไป
- ถ้าสร้างไฟล์สำเร็จ ต้องอ้าง path จาก Artifact ที่ tool ส่งกลับ ห้ามเดาตำแหน่งไฟล์จาก working directory
- อย่าแต่งผลลัพธ์ของเครื่องมือหรืออ้างว่าทำสำเร็จถ้าไม่มีผลลัพธ์ยืนยัน`;
