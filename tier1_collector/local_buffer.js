import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

export class LocalBufferQueue {
  constructor(dbPath) {
    const resolvedPath = dbPath || path.join(process.cwd(), 'tier1_collector', 'data', 'collector_buffer.sqlite');
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new DatabaseSync(resolvedPath);
    this.initDatabase();
  }

  initDatabase() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS local_buffer (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payload_id TEXT UNIQUE NOT NULL,
        tenant_id TEXT NOT NULL,
        created_at_utc TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT DEFAULT 'PENDING',
        delivery_attempts INTEGER DEFAULT 0,
        last_attempt_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_status_created ON local_buffer (status, created_at_utc);
    `);
  }

  enqueue(payload) {
    if (!payload || !payload.payload_id) {
      throw new Error('Payload must contain a unique payload_id');
    }

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO local_buffer (
        payload_id, tenant_id, created_at_utc, payload_json, status, delivery_attempts
      ) VALUES (?, ?, ?, ?, 'PENDING', 0)
    `);

    stmt.run(
      payload.payload_id,
      payload.tenant_id || 'default_tenant',
      payload.timestamp_utc || new Date().toISOString(),
      JSON.stringify(payload)
    );
  }

  peekBatch(limit = 25) {
    const stmt = this.db.prepare(`
      SELECT payload_id, tenant_id, payload_json, delivery_attempts
      FROM local_buffer
      WHERE status = 'PENDING'
      ORDER BY id ASC
      LIMIT ?
    `);
    const rows = stmt.all(limit);
    return rows.map(r => ({
      payload_id: r.payload_id,
      tenant_id: r.tenant_id,
      payload: JSON.parse(r.payload_json),
      delivery_attempts: r.delivery_attempts
    }));
  }

  markAttempt(payload_id) {
    const stmt = this.db.prepare(`
      UPDATE local_buffer
      SET delivery_attempts = delivery_attempts + 1,
          last_attempt_at = ?
      WHERE payload_id = ?
    `);
    stmt.run(new Date().toISOString(), payload_id);
  }

  ack(payload_id) {
    const stmt = this.db.prepare(`
      DELETE FROM local_buffer WHERE payload_id = ?
    `);
    stmt.run(payload_id);
  }

  getBacklogCount() {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM local_buffer WHERE status = 'PENDING'
    `);
    const res = stmt.get();
    return res ? res.count : 0;
  }

  clearAll() {
    this.db.exec(`DELETE FROM local_buffer;`);
  }
}
