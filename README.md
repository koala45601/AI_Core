# อัลฟ่า — Local-first AI สำหรับ Mac

อัลฟ่าเป็นผู้ช่วย AI ภาษาไทยที่รัน Qwen3.5 ผ่าน Ollama บน Mac ของคุณ มีแชตแบบ streaming, แถบสถานะการทำงานและ token, สวิตช์อินเทอร์เน็ต, เครื่องมือสร้างไฟล์จริง, ค้นเว็บด้วย SearXNG, ควบคุมเบราว์เซอร์, ความจำที่ลบได้, Skill Lab และ Auto Learn ที่เลือกสิ่งเรียนจากรูปแบบงานล่าสุด

## External HDD

ตำแหน่งใช้งานหลักคือ `/Volumes/petong/Disk/AI` ซึ่งเก็บ source, ประวัติแชต, Skills, Outputs, browser profile และ Ollama models ไว้ในโฟลเดอร์ธรรมดาบน External HDD

- Node.js และ dependency runtime ใช้ร่วมกันจาก `/Users/ratchanonsakdamanee/Library/Application Support/Alpha Node Runtime` บน Mac จึงไม่ทำสำเนา `node_modules` เกือบ 30,000 ไฟล์ลง ExFAT ที่มี allocation unit 1MB
- เปิดใหม่หลังเสียบดิสก์: ดับเบิลคลิก `เปิดอัลฟ่า.command`
- ปิดโปรแกรม: ดับเบิลคลิก `ปิดอัลฟ่า.command`
- ก่อนถอดดิสก์: ดับเบิลคลิก `ถอด petong อย่างปลอดภัย.command`
- หากดิสก์หลุดระหว่างทำงาน อัลฟ่าจะหยุด Auto Learn, browser และ container ชั่วคราวโดยไม่ติดตั้งงานค้าง เมื่อเสียบกลับให้กดสคริปต์เปิดใหม่ ระบบจะตรวจ UUID และเชื่อมข้อมูลเดิมกลับเอง
- SearXNG ใช้ Docker image ที่ฝัง config ไว้ใน image ไม่มี bind mount มายัง External HDD จึงไม่ทำให้ Docker แจ้ง path หายเมื่อถอดดิสก์

## ความต้องการ

- macOS 14 ขึ้นไป และ Apple Silicon
- RAM 16GB
- [Ollama](https://ollama.com/download/mac)
- Node.js 22 ขึ้นไป
- Docker Desktop สำหรับ SearXNG และ Docker sandbox
- Google Chrome สำหรับ Alpha Browser หรือ Chrome Extension

## เริ่มใช้งานครั้งแรก

1. ติดตั้ง Ollama, Node.js และ Docker Desktop
2. ดับเบิลคลิก `เปิดอัลฟ่า.command` (หรือ `start-alpha.command`)
3. เปิด `http://localhost:3000`

ไฟล์เปิดอัลฟ่าจะสร้าง bearer token ส่วนตัว, เปิด Tool Service, เปิด Ollama และดาวน์โหลด `qwen3.5:9b` เป็นโมเดลหลักพร้อม `qwen3:4b-instruct` สำหรับโหมดเร็วหากยังไม่มี เมื่อเลิกใช้ให้ดับเบิลคลิก `ปิดอัลฟ่า.command` (หรือ `stop-alpha.command`) เพื่อหยุด Tool Service, Alpha Browser, SearXNG, เว็บเซิร์ฟเวอร์, ปลดโมเดลออกจาก RAM และปิด Ollama ไม่ให้ทำงานเบื้องหลัง สคริปต์จะไม่ปิด Docker Desktop หากผู้ใช้เปิดไว้ก่อนอัลฟ่า

## การสร้างไฟล์จริง

- สั่งเช่น “สร้างโปรแกรมเครื่องคิดเลข Python เป็นไฟล์จริง” อัลฟ่าจะเรียก Tool Service และแสดง Artifact Card
- รองรับ `.py`, `.js`, `.mjs`, `.html`, `.css`, `.json`, `.md`, `.txt`, `.csv` และ ZIP โปรเจกต์หลายไฟล์
- ไฟล์เริ่มต้นอยู่ใน `outputs/Alpha Outputs`; ดาวน์โหลด เปิด Finder และ Run/Test ได้จากการ์ด
- Python/JavaScript ถูกตรวจ syntax ก่อนบันทึก เขียนทับมี backup และ symbolic link/path traversal ถูกบล็อก
- การลบย้ายลง Trash และการรันใน Docker sandbox ต้องถามยืนยันเสมอ

## เว็บและเบราว์เซอร์

- การค้นเว็บใช้ SearXNG local container ที่ `127.0.0.1:8888` พร้อม Safe Search strict และใช้ DuckDuckGo แบบข้อความเป็น fallback เมื่อ SearXNG ไม่พร้อม โดยไม่มี image search
- ปิดสวิตช์อินเทอร์เน็ตแล้วระบบจะบล็อก search/read/browser ก่อนส่งคำขอออกจากเครื่อง
- เมื่อสวิตช์อินเทอร์เน็ตเปิดและ Search mode เป็น Auto อัลฟ่าสามารถค้น อ่าน URL และเปิดเว็บได้ทันทีโดยไม่ถามอนุมัติการเชื่อมต่อซ้ำ
- Alpha Browser ใช้โปรไฟล์ Chrome แยกและเปิดไม่เกิน 3 แท็บ
- หากต้องการใช้ Chrome เดิม ให้เปิด `chrome://extensions`, เปิด Developer mode, กด Load unpacked แล้วเลือกโฟลเดอร์ `chrome-extension`; จากนั้นเลือก “Chrome เดิม” ใน Settings และกรอกรหัสจับคู่ในหน้า Options ของ Extension
- CAPTCHA, รหัสผ่าน, OTP, ข้อมูลบัตร และหน้าชำระเงินจะหยุดให้ผู้ใช้รับช่วง
- API Discovery Lab อ่านรายการ `fetch`/XHR/form แบบเดียวกับ Network panel, ปิดบัง secret ในรายงาน และใช้ GET/HEAD/OPTIONS สำรวจได้อัตโนมัติ ส่วน request ที่แก้ข้อมูลต้องเปิด Active testing และเพิ่ม domain ทดสอบเองหนึ่งครั้ง
- SearXNG และ Alpha Browser ปิดอัตโนมัติหลังว่าง 5 นาที (ปรับได้ 1–30 นาที)

หากต้องการเข้าถึง Mail, Messages หรือพื้นที่ที่ macOS ป้องกัน ต้องให้ Full Disk Access แก่ Node/Terminal ที่ใช้เปิด Alpha Tool Service ด้วยตนเองใน System Settings → Privacy & Security → Full Disk Access กฎของอัลฟ่ายังบล็อก Keychain, ฐานข้อมูลรหัสผ่าน และไฟล์ระบบเสมอ

## การใช้ token

อัลฟ่ารันในเครื่องจึงไม่มีโควตาจำนวนข้อความและไม่มีค่าบริการต่อ token จากโมเดล local แต่แต่ละคำขอยังมี context window จำกัด 4,096–8,192 token เพื่อคุม RAM แถบด้านล่างหน้าแชตแสดง token รับเข้า คำตอบ และสัดส่วน context ที่ใช้จริงจาก Ollama

## ความจำ Skill Lab และ Auto Learn

- ประวัติแชตถูกเก็บในฐานข้อมูล local ค้นหา ปักหมุด เก็บถาวร ลบ และ Export ได้
- “สอนอัลฟ่า” บันทึกข้อเท็จจริงหรือความชอบลงฐานข้อมูลในเครื่อง และดึงความจำที่เกี่ยวข้องมาใช้ข้ามแชต
- การเรียนรู้อัตโนมัติเปิดเป็นค่าเริ่มต้น แต่กรองรหัสผ่าน OTP เลขบัตร token และข้อมูลอ่อนไหวออก
- แชตยาวจะถูกสรุปเพื่อใช้ context อย่างประหยัด โดยข้อความฉบับเต็มยังอยู่จนกว่าผู้ใช้จะลบ
- โหมดค้นคว้าจะค้นเว็บ 1–5 รอบ สรุปช่องว่าง สร้างคำค้นรอบถัดไป และหยุดเมื่อความครบถ้วนโดยประมาณถึง 85% หรือครบจำนวนรอบ
- Skill Lab รับเป้าหมายและเกณฑ์ผ่าน สร้างสกิลใน Docker sandbox แบบปิดเครือข่าย อ่านผลทดสอบและแก้เองหลาย attempt โดยไม่ถามระหว่าง loop ติดตั้งเฉพาะสกิลที่ผ่าน และลบ environment, container, image และ test output ชั่วคราวเมื่อจบ
- Auto Learn มีปุ่มเริ่ม 15 นาที–4 ชั่วโมงและปุ่ม “เรียกกลับและสรุปผล” ระบบวิเคราะห์งานจากแชตล่าสุด เช่น ถ้าเขียนโปรแกรมบ่อยจะให้น้ำหนักกับ framework, debugging, testing, architecture, UX, performance และ secure testing
- ทุก Auto Learn session เทียบประวัติ 100 รายการ เลี่ยงหัวข้อซ้ำด้วย similarity และเมื่อหัวข้อใกล้เดิมต้องระบุพัฒนาการ/เกณฑ์วัดผลที่ลึกขึ้น ทุกสามรอบจะพยายามสร้างสกิลที่ทดสอบได้
- หลังจบจะบันทึกรายงาน Markdown/JSON ลง `outputs/Alpha Outputs/Auto Learning`, นำความรู้สำเร็จเข้าความจำ และล้าง working environment เหลือเฉพาะรายงานกับสกิลที่ผ่าน
- “การเรียนรู้” ในระบบนี้คือการเพิ่มความจำ ความรู้ที่มีแหล่งอ้างอิง และสกิลที่ผ่านการทดสอบ ไม่ใช่การแก้ไขน้ำหนักโมเดลอัตโนมัติ จึงย้อนดู/ลบได้และไม่กิน RAM เท่าการ fine-tune

## ข้อจำกัดด้านคุณภาพ

Qwen3.5 9B ให้คุณภาพดีกว่า Qwen3 4B Instruct แต่โมเดล local ขนาดนี้ไม่สามารถเทียบเท่าโมเดล cloud ระดับแนวหน้าได้ทุกงานบน RAM 16GB โหมดค้นเว็บและโหมดฝึกช่วยเรื่องข้อมูลใหม่และความรู้เฉพาะหัวข้อ แต่ไม่ได้เพิ่มความสามารถการให้เหตุผลพื้นฐานของโมเดล

## API

- `POST /api/chat` — คำตอบแบบ SSE streaming
- `GET/POST /api/chats` และ `/api/chats/:id` — ประวัติ ค้นหา ปักหมุด Archive และลบแชต
- `GET /api/chats/:id/export` — ส่งออก Markdown/JSON
- `POST /api/messages/:id/feedback` — ให้คะแนนและบันทึกคำแก้ไข
- `GET/PUT /api/settings` — อ่านและบันทึกการตั้งค่า
- `POST /api/search` — ค้นเว็บแบบ text-only หลังผ่าน policy
- `GET /api/health` — สถานะ Ollama, Docker, SearXNG, เบราว์เซอร์, Tool Service และ RAM
- `GET /api/tools/health` — สถานะเครื่องมือและรหัสจับคู่ Extension
- `POST /api/tools/confirm` — ยืนยันหรือปฏิเสธงานไฟล์/การรัน
- `GET /api/artifacts/:id` — ดาวน์โหลดไฟล์ที่สร้างจริง
- `GET/POST/DELETE /api/memory` — จัดการคลังความรู้
- `POST /api/train` — โหมดฝึกแบบค้นคว้าวนซ้ำ
- `GET/POST/DELETE /api/auto-learn` — อ่านสถานะ เริ่ม และเรียกกลับ Auto Learn

## ทดสอบและ build

`pnpm test` จะ build แอปและทดสอบ policy, SSR, การสร้างไฟล์จริง, syntax validation, permission, path traversal, symlink escape และ SSRF
