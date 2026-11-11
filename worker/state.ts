// Worker state: SQLite (node:sqlite, no native deps) + AES-256-GCM store for sealed mandate terms.
// Chain is the source of truth for mandate status and recorded chunks; this DB holds what the chain cannot:
// in-flight chunk intents (idempotency keys, OutLayer request ids), settlement items, samples, events.
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export type ChunkStatus = 'planned' | 'submitted' | 'success' | 'failed' | 'refunded';
export interface ChunkRow {
  mandate_id: number; idx: number; attempt: number; idem_key: string; size: string; status: ChunkStatus;
  request_id: string | null; intent_hash: string | null; quote_out: string | null; amount_out: string | null;
  min_out: string | null; ts: number; recorded: number; note: string | null;
}
export interface SettlementItem {
  mandate_id: number; key: string; kind: 'fee' | 'payout' | 'return_sell' | 'return_buy'; label: string; chain: string; address: string;
  token: string; amount: string; status: 'pending' | 'submitted' | 'success' | 'failed' | 'refunded' | 'needs_review';
  request_id: string | null; dest_tx: string | null; attempts: number; note: string | null; next_try_at: number;
}
export interface Runtime { mandate_id: number; next_at: number; phase: string; floor_misses: number; violations: number; funded: number; stop_reason: string | null }

export function loadKey(raw = process.env.SEALED_TERMS_KEY): Buffer {
  if (!raw) throw new Error('SEALED_TERMS_KEY not set (32 bytes, hex or base64)');
  const b = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (b.length !== 32) throw new Error('SEALED_TERMS_KEY must decode to 32 bytes');
  return b;
}

export class State {
  readonly db: DatabaseSync;
  constructor(path = ':memory:', private key?: Buffer) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS terms(terms_hash TEXT PRIMARY KEY, sealed INTEGER NOT NULL, body BLOB NOT NULL, iv BLOB, tag BLOB);
      CREATE TABLE IF NOT EXISTS chunks(mandate_id INTEGER, idx INTEGER, attempt INTEGER, idem_key TEXT, size TEXT, status TEXT, request_id TEXT, intent_hash TEXT,
        quote_out TEXT, amount_out TEXT, min_out TEXT, ts INTEGER, recorded INTEGER DEFAULT 0, note TEXT, PRIMARY KEY(mandate_id, idx));
      CREATE TABLE IF NOT EXISTS runtime(mandate_id INTEGER PRIMARY KEY, next_at INTEGER DEFAULT 0, phase TEXT DEFAULT 'new', floor_misses INTEGER DEFAULT 0,
        violations INTEGER DEFAULT 0, funded INTEGER DEFAULT 0, stop_reason TEXT);
      CREATE TABLE IF NOT EXISTS samples(mandate_id INTEGER, ts INTEGER, price REAL, origin TEXT, source TEXT);
      CREATE TABLE IF NOT EXISTS items(mandate_id INTEGER, key TEXT, kind TEXT, label TEXT, chain TEXT, address TEXT, token TEXT, amount TEXT, status TEXT,
        request_id TEXT, dest_tx TEXT, attempts INTEGER DEFAULT 0, note TEXT, next_try_at INTEGER DEFAULT 0, PRIMARY KEY(mandate_id, key));
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, mandate_id INTEGER, kind TEXT, detail TEXT);
      CREATE TABLE IF NOT EXISTS violations(id INTEGER PRIMARY KEY AUTOINCREMENT, mandate_id INTEGER, code TEXT, detail TEXT);
      CREATE TABLE IF NOT EXISTS reports(mandate_id INTEGER PRIMARY KEY, json TEXT NOT NULL);
    `);
  }

  // ---- sealed / plain terms ----
  saveTerms(hash: string, json: string, sealed: boolean) {
    if (sealed) {
      if (!this.key) throw new Error('no SEALED_TERMS_KEY configured');
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', this.key, iv);
      const body = Buffer.concat([c.update(json, 'utf8'), c.final()]);
      this.db.prepare('INSERT OR REPLACE INTO terms VALUES(?,?,?,?,?)').run(hash, 1, body, iv, c.getAuthTag());
    } else this.db.prepare('INSERT OR REPLACE INTO terms VALUES(?,?,?,?,?)').run(hash, 0, Buffer.from(json, 'utf8'), null, null);
  }
  loadTerms(hash: string): string | null {
    const r = this.db.prepare('SELECT * FROM terms WHERE terms_hash=?').get(hash) as any;
    if (!r) return null;
    if (!r.sealed) return Buffer.from(r.body).toString('utf8');
    if (!this.key) throw new Error('no SEALED_TERMS_KEY configured');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(r.iv));
    d.setAuthTag(Buffer.from(r.tag));
    return Buffer.concat([d.update(Buffer.from(r.body)), d.final()]).toString('utf8');
  }

  // ---- runtime ----
  runtime(id: number): Runtime {
    this.db.prepare('INSERT OR IGNORE INTO runtime(mandate_id) VALUES(?)').run(id);
    return this.db.prepare('SELECT * FROM runtime WHERE mandate_id=?').get(id) as unknown as Runtime;
  }
  setRuntime(id: number, patch: Partial<Omit<Runtime, 'mandate_id'>>) {
    this.runtime(id);
    for (const [k, v] of Object.entries(patch)) this.db.prepare(`UPDATE runtime SET ${k}=? WHERE mandate_id=?`).run(v as any, id);
  }

  // ---- chunks ----
  chunk(id: number, idx: number): ChunkRow | undefined {
    return this.db.prepare('SELECT * FROM chunks WHERE mandate_id=? AND idx=?').get(id, idx) as unknown as ChunkRow | undefined;
  }
  chunks(id: number): ChunkRow[] {
    return this.db.prepare('SELECT * FROM chunks WHERE mandate_id=? ORDER BY idx').all(id) as unknown as ChunkRow[];
  }
  putChunk(c: Omit<ChunkRow, 'recorded' | 'note'> & { recorded?: number; note?: string | null }) {
    this.db.prepare('INSERT OR REPLACE INTO chunks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      c.mandate_id, c.idx, c.attempt, c.idem_key, c.size, c.status, c.request_id, c.intent_hash, c.quote_out, c.amount_out, c.min_out, c.ts, c.recorded ?? 0, c.note ?? null);
  }
  patchChunk(id: number, idx: number, patch: Partial<ChunkRow>) {
    for (const [k, v] of Object.entries(patch)) this.db.prepare(`UPDATE chunks SET ${k}=? WHERE mandate_id=? AND idx=?`).run(v as any, id, idx);
  }

  // ---- samples / events / violations ----
  addSample(id: number, ts: number, price: number, origin: string, source: string) { this.db.prepare('INSERT INTO samples VALUES(?,?,?,?,?)').run(id, ts, price, origin, source); }
  samples(id: number) { return this.db.prepare('SELECT ts, price, origin, source FROM samples WHERE mandate_id=? ORDER BY ts').all(id) as unknown as Array<{ ts: number; price: number; origin: string; source: 'chain' | 'api' | 'recorded' }>; }
  event(ts: number, id: number, kind: string, detail: unknown) { this.db.prepare('INSERT INTO events(ts,mandate_id,kind,detail) VALUES(?,?,?,?)').run(ts, id, kind, JSON.stringify(detail)); }
  events(id: number) { return this.db.prepare('SELECT * FROM events WHERE mandate_id=? ORDER BY id').all(id) as unknown as Array<{ id: number; ts: number; kind: string; detail: string }>; }
  allEvents() { return this.db.prepare('SELECT * FROM events ORDER BY id').all() as unknown as Array<{ id: number; ts: number; mandate_id: number; kind: string; detail: string }>; }
  addViolation(id: number, code: string, detail: string) {
    this.db.prepare('INSERT INTO violations(mandate_id,code,detail) VALUES(?,?,?)').run(id, code, detail);
    this.db.prepare('INSERT OR IGNORE INTO runtime(mandate_id) VALUES(?)').run(id);
    this.db.prepare('UPDATE runtime SET violations=violations+1 WHERE mandate_id=?').run(id);
  }
  violations(id: number) { return this.db.prepare('SELECT code, detail FROM violations WHERE mandate_id=?').all(id) as unknown as Array<{ code: string; detail: string }>; }

  // ---- settlement items ----
  item(id: number, key: string) { return this.db.prepare('SELECT * FROM items WHERE mandate_id=? AND key=?').get(id, key) as unknown as SettlementItem | undefined; }
  items(id: number) { return this.db.prepare('SELECT * FROM items WHERE mandate_id=? ORDER BY rowid').all(id) as unknown as SettlementItem[]; }
  putItem(i: Omit<SettlementItem, 'attempts' | 'note' | 'next_try_at' | 'request_id' | 'dest_tx'> & Partial<SettlementItem>) {
    this.db.prepare('INSERT OR IGNORE INTO items(mandate_id,key,kind,label,chain,address,token,amount,status,request_id,dest_tx,attempts,note,next_try_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      i.mandate_id, i.key, i.kind, i.label, i.chain, i.address, i.token, i.amount, i.status, i.request_id ?? null, i.dest_tx ?? null, i.attempts ?? 0, i.note ?? null, i.next_try_at ?? 0);
  }
  patchItem(id: number, key: string, patch: Partial<SettlementItem>) {
    for (const [k, v] of Object.entries(patch)) this.db.prepare(`UPDATE items SET ${k}=? WHERE mandate_id=? AND key=?`).run(v as any, id, key);
  }

  // ---- reports ----
  saveReport(id: number, json: unknown) { this.db.prepare('INSERT OR REPLACE INTO reports VALUES(?,?)').run(id, JSON.stringify(json)); }
  report(id: number): any | null { const r = this.db.prepare('SELECT json FROM reports WHERE mandate_id=?').get(id) as any; return r ? JSON.parse(r.json) : null; }
  close() { this.db.close(); }
}

