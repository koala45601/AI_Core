# Alpha Ticket Studio Work Tracker

ไฟล์นี้เป็นจุดอ้างอิงงานต่อเนื่องของโปรเจกต์ ต้องอ่านก่อนแก้ไขทุกครั้ง และอัปเดตสถานะทันทีเมื่อเริ่มหรือจบแต่ละหัวข้อ

สถานะที่ใช้: `pending`, `in_progress`, `completed`, `blocked`

## งานรอบ 2026-09-01

- [ ] `in_progress` บันทึกและ push baseline ThaiTicketMajor `2.0.0-alpha.12` แบบ source-only โดยไม่รวม generated/cache/output/runtime profiles
- [ ] `pending` (Luna MAX worker · Sol reviewer) แยก provider boundary และเพิ่ม Ticketier inspection/API discovery โดยไม่เปลี่ยน flow ThaiTicketMajor
- [ ] `pending` (Luna MAX worker · Sol reviewer) เพิ่ม Ticketier GA API-first runtime, session recovery, retry และ QR `PAYMENT_HANDOFF`
- [ ] `pending` ปรับ Ticket Studio/events/config สำหรับสอง provider และบั๊ม `2.0.0-alpha.13`
- [ ] `pending` รัน ThaiTicketMajor regression, Ticketier fixtures, production build, Browser QA และ live acceptance ก่อน commit/push

- [x] `completed` วิเคราะห์สาเหตุที่ runtime ค้างบน seat map และแก้เป็นกฎกลาง ไม่ผูกเฉพาะคอนเสิร์ต
- [x] `completed` ตรวจและผูกเงื่อนไข คอนเสิร์ต → รอบ → โซน → ราคา → แถว/เลขที่นั่ง → จำนวนบัตร ให้ครบ
- [x] `completed` ทำให้เลขที่นั่งเป็นเงื่อนไขเมื่อผู้ใช้กรอก และเลือกที่ว่างอัตโนมัติเมื่อเว้นว่าง
- [x] `completed` ปิด run/browser session พร้อมผลสรุปเมื่อราคาที่ล็อกไม่มีชุดที่นั่งครบ และแสดงทางเลือกที่ยังว่างโดยไม่เปลี่ยนราคาเอง
- [x] `completed` (Luna worker · Sol reviewed) บันทึกข้อมูลผู้ซื้อ/ผู้รับ/เบอร์โทร/วิธีรับบัตร/การชำระเงินในเครื่อง และเติมกลับอัตโนมัติ โดยไม่บันทึกรหัสผ่านใน browser storage
- [x] `completed` (Luna worker · Sol browser QA) ปรับ Ticket Studio และ Ticket Run Card ให้อ่านสถานะ สาเหตุ งานปัจจุบัน ขั้นถัดไป และตัวเลือกที่ว่างได้ง่าย
- [x] `completed` เพิ่ม/ปรับ regression tests สำหรับกฎทั้งหมด
- [x] `completed` บั๊มเวอร์ชันเป็น `2.0.0-alpha.8` เพื่อบังคับสร้างบอทรุ่นใหม่จากโค้ดชุดนี้
- [x] `completed` รัน tests และ production build (`169/169` ผ่าน; build และ UI test หลัง browser QA ผ่าน)
- [x] `completed` สรุปไฟล์ที่แก้ หลักฐาน และงานที่ยังเหลือ
- [x] `completed` (Luna worker · Sol reviewed; Luna ชน usage limit หลังเขียน diff) ล็อกแถบสรุปคอนเสิร์ตและเงื่อนไขที่เลือกไว้ให้ติดด้านบนขณะเลื่อน โดยไม่บังฟอร์มหรือ action bar
- [x] `completed` (Luna MAX worker · Sol reviewed) ตรวจ sticky summary บน desktop/tablet/mobile, targeted UI test `4/4`, `git diff --check` และ production build ผ่าน; Browser โหลดหน้าแอปเป็น `v2.0.0-alpha.9` แล้ว
- [x] `completed` บั๊มเวอร์ชัน UI fix รอบนี้เป็น `2.0.0-alpha.9` เพื่อไม่ให้การแก้ sticky หลุดจาก version control
- [x] `completed` (Luna MAX worker · Sol reviewed) ย้ายกล่องสรุปที่เลือกทั้งกล่องออกจากพื้นที่ scroll ให้เป็นแถวคงที่ของ config pane เพื่อห้ามเนื้อหาเลื่อนซ้อนใต้กล่อง
- [x] `completed` ปรับ responsive และ regression test สำหรับโครงสร้าง fixed summary row (`4/4` ผ่าน และ `git diff --check` ผ่าน)
- [x] `completed` บั๊มเวอร์ชันเป็น `2.0.0-alpha.10`; targeted test `4/4`, production build และ Browser QA ผ่าน โดย DOM จริงเป็น `header → summary → scroller`, summary เป็น direct child แบบ `position: static` และเลื่อนเฉพาะ scroller (`overflow-y: auto`)
- [x] `completed` (Luna MAX ทำได้บางส่วน · Sol implemented/reviewed) เมื่อหน้า Booking จำกัดจำนวนต่ำกว่าที่ขอ runtime ลดเป็น official option สูงสุดที่ไม่เกินจำนวนที่ขอและทำงานต่ออัตโนมัติ โดยไม่สร้าง `input_required`
- [x] `completed` แสดงคำเตือนลิมิตและจำนวนที่ปรับแล้วในกล่องสรุปคงที่ด้านบน พร้อม sync จำนวนที่ runtime ใช้จริงกลับเข้า UI
- [x] `completed` เพิ่ม regression tests, บั๊มเป็น `2.0.0-alpha.11`, รัน tests/build ผ่าน (`171/171`) และตรวจ Browser จริงแล้วว่าโหลด `v2.0.0-alpha.11`, กล่องสรุปอยู่ใต้ `ticket-config-pane` และมี style คำเตือนลิมิตจำนวนบัตร
- [x] `completed` (Luna MAX worker · Sol implemented/reviewed) แก้กฎกลางราคาโซนแบบก่อน VAT ↔ ราคารวม VAT จากหลักฐานทางการ เช่น 4,500 ↔ 4,815 โดยห้ามเปลี่ยนไป tier ราคาอื่น
- [x] `completed` แก้ availability modal ที่ค้าง spinner ไม่ให้บล็อกการเข้าโซนที่สอดคล้องกับราคาที่ล็อก เมื่อมีหลักฐาน zone/price จากหน้าเว็บแล้ว และให้ Fast Seat Engine เริ่มจากโซน live ที่เพิ่งเข้าแทนการย้อนกลับไปลำดับหน้าเดิม
- [x] `completed` เพิ่ม regression tests สำหรับโซน live A2 ไม่ย้อน B1, cache modal และ candidate price flow 4,500↔4,815 โดยไม่รับ tier อื่น; บั๊มเป็น `2.0.0-alpha.12`; production build และ tests ผ่าน `171/171`; Browser/Tool Service health และ bundled generator sync ยืนยันว่าโหลด `2.0.0-alpha.12`

## ข้อจำกัดถาวร

- ห้ามแก้ generated/cache/output ที่ไม่เกี่ยวข้องกับงาน
- ห้ามเปลี่ยนคอนเสิร์ต รอบ โซน ราคา หรือจำนวนบัตรนอกค่าที่ผู้ใช้อนุญาต
- ห้ามเดาราคา/ที่นั่ง/สถานะหมด ต้องอาศัยข้อมูลจากหน้าเว็บหรือ API ที่ยืนยันแล้ว
- ห้ามชำระเงินจริงอัตโนมัติ ให้หยุดที่ `PAYMENT_HANDOFF`
- รักษา queue, CAPTCHA, OTP, rate limit และ anti-abuse controls
- ก่อนเริ่มแก้รอบใหม่ ต้องอ่านไฟล์นี้ก่อนเสมอ
