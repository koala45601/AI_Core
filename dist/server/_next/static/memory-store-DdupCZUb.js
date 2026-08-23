import{env as e}from"cloudflare:workers";var t=`
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    normalized_content TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL DEFAULT 'manual',
    category TEXT NOT NULL DEFAULT 'general',
    source_chat_id TEXT,
    confidence INTEGER NOT NULL DEFAULT 80,
    pinned INTEGER NOT NULL DEFAULT 0,
    last_used_at INTEGER,
    updated_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )
`;function n(){return e.DB}async function r(e){await e.prepare(t).run();for(let t of[`ALTER TABLE memories ADD COLUMN category TEXT NOT NULL DEFAULT 'general'`,`ALTER TABLE memories ADD COLUMN source_chat_id TEXT`,`ALTER TABLE memories ADD COLUMN confidence INTEGER NOT NULL DEFAULT 80`,`ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`,`ALTER TABLE memories ADD COLUMN last_used_at INTEGER`,`ALTER TABLE memories ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0`])await e.prepare(t).run().catch(()=>void 0);await e.prepare(`CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at DESC)`).run(),await e.prepare(`CREATE INDEX IF NOT EXISTS idx_memories_pinned ON memories(pinned DESC)`).run()}function i(e){return e.normalize(`NFKC`).toLowerCase().replace(/\s+/g,` `).trim()}function a(e){return new Set(i(e).split(/[^\p{L}\p{N}_]+/u).filter(e=>e.length>1))}function o(e){let t=i(e).replace(/[^\p{L}\p{N}]+/gu,``),n=new Set;for(let e=0;e<=t.length-3;e+=1)n.add(t.slice(e,e+3));return n}async function s(e=100){let t=n();return t?(await r(t),(await t.prepare(`
    SELECT id, content, source, category, source_chat_id, confidence, pinned, last_used_at, updated_at, created_at
    FROM memories
    ORDER BY pinned DESC, updated_at DESC, created_at DESC
    LIMIT ?
  `).bind(Math.min(200,Math.max(1,e))).all()).results??[]):[]}function c(e){let t=i(e);return/(password|passcode|รหัสผ่าน|otp|one[- ]?time|cvv|cvc|เลขบัตร|credit card|debit card|บัตรเครดิต|seed phrase|private key|api[_ -]?key|access[_ -]?token)/i.test(t)||/(?:\d[ -]*?){13,19}/.test(t)}async function l(e,t=`manual`,a={}){let o=e.trim().slice(0,2e3);if(!o||t!==`manual`&&c(o))return null;let s=n();if(!s)return null;await r(s);let l=i(o);return await s.prepare(`
    INSERT INTO memories (content, normalized_content, source, category, source_chat_id, confidence, pinned, updated_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(normalized_content) DO UPDATE SET content = excluded.content, source = excluded.source,
      category = excluded.category, source_chat_id = COALESCE(excluded.source_chat_id, memories.source_chat_id),
      confidence = MAX(memories.confidence, excluded.confidence), pinned = MAX(memories.pinned, excluded.pinned), updated_at = excluded.updated_at
  `).bind(o,l,t,a.category??(t===`research`?`research`:t===`correction`?`correction`:`general`),a.sourceChatId??null,Math.min(100,Math.max(0,a.confidence??80)),+!!a.pinned,Date.now(),Date.now()).run(),s.prepare(`
    SELECT id, content, source, category, source_chat_id, confidence, pinned, last_used_at, updated_at, created_at
    FROM memories WHERE normalized_content = ?
  `).bind(l).first()}async function u(e,t){let a=n();if(!a)return null;if(await r(a),typeof t.content==`string`){let n=t.content.trim().slice(0,2e3);if(!n)return null;await a.prepare(`UPDATE memories SET content = ?, normalized_content = ?, updated_at = ? WHERE id = ?`).bind(n,i(n),Date.now(),e).run()}return typeof t.pinned==`boolean`&&await a.prepare(`UPDATE memories SET pinned = ?, updated_at = ? WHERE id = ?`).bind(+!!t.pinned,Date.now(),e).run(),t.category&&await a.prepare(`UPDATE memories SET category = ?, updated_at = ? WHERE id = ?`).bind(t.category,Date.now(),e).run(),a.prepare(`SELECT id, content, source, category, source_chat_id, confidence, pinned, last_used_at, updated_at, created_at
    FROM memories WHERE id = ?`).bind(e).first()}async function d(e){let t=n();return t?(await r(t),!!(await t.prepare(`DELETE FROM memories WHERE id = ?`).bind(e).run()).meta.changes):!1}async function f(e,t=5){let n=a(e),r=o(e);return!n.size&&!r.size?[]:(await s(200)).map(e=>{let t=a(e.content),i=o(e.content),s=0;for(let e of n)t.has(e)&&(s+=1);let c=0;for(let e of r)i.has(e)&&(c+=1);let l=r.size?c/r.size:0;return{memory:e,score:s*2+l+(e.pinned?3:0)}}).filter(e=>e.score>=.12).sort((e,t)=>t.score-e.score||t.memory.created_at-e.memory.created_at).slice(0,t).map(e=>e.memory)}export{u as a,s as i,d as n,f as r,l as t};