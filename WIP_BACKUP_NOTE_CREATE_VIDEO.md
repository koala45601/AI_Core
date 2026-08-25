# Pre-Create Video WIP Backup Note

เอกสารนี้บันทึกสถานะก่อนเริ่มงาน Create Video เพื่อกันความสับสนระหว่างงานใหม่กับ Ticket Bot/Beta21

## Important

จากสถานะ local ล่าสุด มี pre-existing Ticket Bot/WIP ที่ยังไม่ได้ commit และมี generated build artifacts (`dist/...`) ที่ถูกแก้/ลบจำนวนมาก รวมถึง untracked file เช่น `lib/ticket-event-cache.ts`.

ดังนั้น backup branch นี้เป็นเพียง Git snapshot ของ commit ที่ push แล้ว และ **ไม่ควรถูกตีความว่าได้เก็บ uncommitted local working tree ครบทุกไฟล์แล้ว**.

ก่อนทำ cleanup/reset/rebase/restore ใด ๆ ต้องตรวจ local working tree ของ `/Volumes/petong/Disk/AI_Core_beta14` ก่อน เพื่อไม่ให้ Ticket Bot WIP สูญหาย

## Scope Guard

งาน Create Video ต้องทำบน `feature/create-video-v1` และห้ามแก้ Ticket Bot/Beta21 WIP โดยตั้งใจ

อย่าใช้ `git reset --hard`, `git clean -fd` หรือ restore แบบกว้าง ๆ จนกว่าจะยืนยันว่า local WIP ถูก backup/commit อย่างปลอดภัยแล้ว
