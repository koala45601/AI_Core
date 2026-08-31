# Prompt ทำงานต่อ — Alpha Ticket Studio 2.0

คุณกำลังทำงานต่อในโปรเจกต์ Alpha ที่ `/Volumes/petong/Disk/AI` บนสาขา `feat/alpha-v2-autonomous-runtime`

## กติกาก่อนเริ่ม

- อ่านไฟล์นี้และตรวจสถานะ Git ก่อนทำอะไรทั้งหมด
- ห้ามเริ่มเขียนระบบ Ticket Bot ใหม่ และห้ามย้อนกลับไปใช้ beta/1.x
- เวอร์ชันปัจจุบันคือ `2.0.0-alpha.2`
- `package.json` เป็นแหล่งเวอร์ชันเดียว ห้าม hardcode เลขเวอร์ชันปัจจุบันซ้ำใน UI, Tool Service, generator หรือ regression tests
- UI ต้องอ่าน `ALPHA_VERSION`; Tool Service ต้องอ่าน `appVersion`; generator ต้องรับ `ALPHA_APP_VERSION` หรืออ่าน `package.json` เมื่อรันตรง
- fixture เก่ามีสิทธิ์เก็บเลขเวอร์ชันเก่าเพื่อทดสอบ migration แต่ห้ามใช้ fixture บังคับเวอร์ชันปัจจุบัน
- อย่าแตะ `Program_Create`, `outputs`, `work`, `dist`, `.next`, `.vinext`, `.wrangler`, browser profiles หรือไฟล์ AppleDouble `._*` เพื่อทำ source commit
- ห้าม commit credentials, cookies, session/token, QR หรือข้อมูลส่วนตัว
- Browser ใช้สำหรับ login/session, CAPTCHA/OTP และ payment handoff; operation อื่นให้ใช้ verified frontend API ก่อนเมื่อเว็บมี API ที่ยืนยันจาก session ปัจจุบัน
- ห้าม bypass queue, CAPTCHA, rate limit หรือ anti-abuse control และห้ามชำระเงินจริง
- ถ้ายังไม่มีหลักฐาน live ห้ามรายงานว่า Full Loop ผ่านจาก fixture หรือ HTTP 200 เพียงอย่างเดียว

## สิ่งที่เสร็จแล้ว ห้ามทำใหม่โดยไม่มีหลักฐานว่าพัง

1. Version control ใช้ single source of truth จาก `package.json` แล้ว
2. Production build และชุดทดสอบทั้งหมดผ่าน `161/161`
3. Ticket Studio มี price dropdown ต่อคอน, ล้างราคาเมื่อเปลี่ยนคอน และไม่เดาราคา
4. การตรวจคอนปิด inspection browser/context ที่ Alpha เป็นเจ้าของเมื่อจบ โดยไม่ปิด Chrome ส่วนตัว
5. Runtime log หลักเป็นภาษาไทยและมี AI/runtime recovery status
6. ตัวเลือกที่นั่งรองรับ verified availability, conflict recovery, partial release, navigation interrupt และ API-first speed path
7. General admission/บัตรยืนมี quantity flow และมีหลักฐาน Live Full Loop เดิมแล้ว
8. Reserved-seat flow มีหลักฐาน Live Full Loop เดิมแล้ว

หลักฐาน live ที่มีอยู่แล้ว:

- Reserved seat BABYMONSTER: run `6c249543-5048-42d9-a624-9fbd99d173d4` มี `reservation_verified` และ `PAYMENT_HANDOFF`
- Reserved seat Singing Contest: run `01dd02d1-f9fa-4faf-b294-45f1592f67fd` มี `reservation_verified` และ `PAYMENT_HANDOFF`
- General admission ISLAND ENCORE: run `a8dd9d8a-b2ef-4591-a68a-b34c464e1307` มี `reservation_verified` และ `PAYMENT_HANDOFF`
- JOJI general admission รุ่นก่อนหน้า: `Program_Create/joji-solaris-tour-2026-ticket-bot-beta28-visual/run-report.jsonl` มีหลักฐานครบ

เคส modal `Available` และ general-admission ล่าสุดไม่อยู่ใน backlog นี้ เพราะผู้ใช้จะทดสอบเอง ห้ามเสียเวลาเปิดหรือทดสอบซ้ำ เว้นแต่ผู้ใช้ส่งผลล้มเหลวใหม่มาโดยตรง

## งานที่ยังค้างจริง เรียงตามลำดับ

### 1. Acceptance เวอร์ชันและ stale-project rebuild

1. เปิด Alpha ใหม่และยืนยันว่า UI แสดง `2.0.0-alpha.2`
2. ตรวจ Tool Service health ว่า `app_version` เป็นค่าเดียวกับ `package.json`
3. สร้าง Ticket Bot ใหม่หนึ่งครั้งและตรวจ `config.json.generatorVersion` ว่าตรงกับ `package.json`
4. ลองรันโปรเจกต์ `alpha.1` เก่าและยืนยันว่าระบบสั่งสร้างใหม่อย่างชัดเจน ไม่รันบอทเก่าต่อและไม่เงียบ
5. ห้ามแก้เลขใน test เมื่อ bump รุ่นถัดไป; เปลี่ยนเฉพาะ `package.json` แล้วทุกส่วนต้องตามเอง

### 2. Reserved-seat regression หลังแพตช์ล่าสุด

1. BABYMONSTER: modal availability ต้องคัดโซน 0 ออกและเข้าผังที่นั่งโดยไม่สุ่มโซนที่ไม่มีของ
2. DREAMING TOMOHISA YAMASHITA: ต้องรับมือการเลือกวัน/รอบซ้ำหลังเข้าหน้า booking และไปต่อจาก reservation ที่มีอยู่แล้วจน `PAYMENT_HANDOFF`
3. จำลองหรือรอ seat conflict/X: blacklist แบบ TTL, release partial และหา complete set ใหม่โดยไม่จบ run
4. ทดสอบผู้ใช้กดย้อนจากผังที่นั่ง: ต้อง emit `navigation_interrupt`, ไม่แย่งเมาส์ และ resume หลังผู้ใช้หยุด 2 วินาที
5. ตรวจ event `reservation_verified.selected`; ปัจจุบันหลักฐานบาง run มีรายการ `seats` ครบแต่ field `selected` เป็น `0` ต้องแก้เฉพาะการคำนวณ/รายงาน event ให้ตรงกับจำนวนที่ server ยืนยัน โดยไม่ลดเกณฑ์การยืนยัน reservation

### 3. Ticket Studio UI/inspection acceptance

1. ตรวจคอน A ที่มีหลายราคาแล้ว dropdown ต้องแสดงเฉพาะราคาจริงของ A
2. เปลี่ยนเป็นคอน B แล้วราคาของ A ต้องหายทันที
3. ถ้าไม่พบราคา dropdown ต้องแสดง “ไม่จำกัด / ไม่ระบุราคา” และห้ามเดาราคา
4. กดตรวจคอนซ้ำหลายครั้งแล้วต้องไม่มี inspection browser เก่าค้าง
5. ตรวจ desktop/tablet/mobile ว่าความสูง input/select/button, payment cards และ sticky action bar อยู่แนวเดียวกัน

### 4. AI Supervisor/runtime recovery acceptance จริง

ทดสอบผ่าน service จริง ไม่ใช่แค่อ่าน source:

1. ปิด Browser ของ Alpha ระหว่าง run → reconnect/resume session เดิมหรือแจ้งสาเหตุจริง
2. ทำ page/context หาย → เปลี่ยน recovery strategy และไม่วน fingerprint เดิม
3. restart Tool Service → UI ต้องไม่เงียบและ run ต้องมี heartbeat/diagnosis ภาษาไทย
4. หน้าโหลดไม่สมบูรณ์ → รอ page-ready แบบ event/state ไม่ใช้ fixed sleep แล้วทำต่อ
5. ไม่มี source diff → ใช้ transient runtime recovery ได้ ไม่สร้าง source-patch ปลอม
6. เคสต้องแก้ source → สร้าง repair sandbox, diff, tests และรอผู้ใช้อนุมัติก่อน promote
7. health check หลัง promote ล้มเหลว → rollback อัตโนมัติ
8. CAPTCHA/OTP ต้องเปิดให้ผู้ใช้ทำและ resume session เดิม; ห้ามอ้าง CAPTCHA หากหน้าไม่มี CAPTCHA จริง

### 5. Acceptance สถานะขายสี่รูปแบบบน build ปัจจุบัน

ยืนยันอย่างน้อยหนึ่งหลักฐานต่อสถานะ โดยไม่จำเป็นต้องจองในสถานะที่ซื้อไม่ได้:

- เปิดขายและมีบัตร: ไปถึง `PAYMENT_HANDOFF`
- กำลังจะเปิดขาย: แยก same-day/ภายในช่วงเข้าคิวออกจาก future-day และรักษา session เฉพาะเมื่อจำเป็น
- ปิดขาย/จบงาน: server-confirmed terminal พร้อม screenshot
- เปิดขายแต่ SOLD OUT: server-confirmed SOLD OUT พร้อม screenshot

หากหลักฐานเดิมยังตรงกับ source/runtime ปัจจุบันให้ตรวจความเข้ากันได้ก่อน ไม่ต้องยิงเว็บซ้ำโดยไม่มีเหตุผล

## คำสั่งตรวจขั้นต่ำก่อนส่งงาน

```bash
cd /Volumes/petong/Disk/AI
python3 -m py_compile templates/concert-ticket-assistant.py
pnpm test
rg -n '2\.0\.0-alpha\.[0-9]+' app lib tool-service templates scripts tests package.json
git status --short --branch
```

ผลที่คาดจาก `rg`: เลขเวอร์ชันปัจจุบันปรากฏเป็นค่าจริงเฉพาะ `package.json`; source/test อื่นต้องอ้างตัวแปรหรืออ่าน package version

## วิธีรายงานผล

รายงานเป็นตาราง: เคส, event/run id, state สุดท้าย, `reservation_verified`, `PAYMENT_HANDOFF`, screenshot, ผ่าน/ไม่ผ่าน, สาเหตุจริง และสิ่งที่แก้

ห้ามใช้คำว่า “Full Loop ผ่าน” เว้นแต่ run เดียวกันมีทั้ง `reservation_verified` และ `PAYMENT_HANDOFF` จากเว็บจริง และต้องยืนยัน `payment_not_submitted: true`

เมื่อแก้ source เพิ่ม ให้ bump patch prerelease ใน `package.json` เพียงจุดเดียว รัน tests ทั้งหมด แล้ว commit เฉพาะ source/test/prompt ที่เกี่ยวข้อง ห้ามรวม generated/cache/runtime evidence หรือ secrets
