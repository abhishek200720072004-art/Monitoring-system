import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

export class MultiTenantMetadataStore {
  constructor(region = 'ap-south-1') {
    this.region = region;
    this.dbPath = path.join(process.cwd(), 'tier2_saas', 'data', `saas_metadata_${region}.sqlite`);
    
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new DatabaseSync(this.dbPath);
    this.initDatabase();
  }

  initDatabase() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      -- Processed payloads for idempotency deduplication
      CREATE TABLE IF NOT EXISTS processed_payloads (
        payload_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        ingested_at_utc TEXT NOT NULL,
        event_timestamp_utc TEXT NOT NULL
      );

      -- Time-series telemetry metadata (Allow-listed only)
      CREATE TABLE IF NOT EXISTS telemetry_metadata (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payload_id TEXT UNIQUE NOT NULL,
        tenant_id TEXT NOT NULL,
        collector_id TEXT NOT NULL,
        pseudonym_source_id TEXT NOT NULL,
        event_timestamp_utc TEXT NOT NULL,
        source_tz TEXT NOT NULL,
        source_type TEXT NOT NULL,
        cpu_percent REAL,
        memory_percent REAL,
        disk_io_percent REAL,
        latency_ms REAL,
        packet_loss_percent REAL,
        bandwidth_mbps REAL,
        error_rate_percent REAL,
        health_indicator TEXT,
        event_category TEXT,
        severity TEXT,
        alert_context TEXT,
        security_summary_json TEXT,
        redaction_count INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_telemetry_tenant_time 
      ON telemetry_metadata (tenant_id, event_timestamp_utc);

      -- Health state history transitions
      CREATE TABLE IF NOT EXISTS health_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        previous_state TEXT NOT NULL,
        new_state TEXT NOT NULL,
        reason TEXT NOT NULL,
        timestamp_utc TEXT NOT NULL
      );

      -- Autonomous Ops remediation audit logs
      CREATE TABLE IF NOT EXISTS autonomous_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action_id TEXT UNIQUE NOT NULL,
        tenant_id TEXT NOT NULL,
        incident_id TEXT,
        action_name TEXT NOT NULL,
        target_component TEXT NOT NULL,
        status TEXT NOT NULL,
        approved_by TEXT,
        initiated_at_utc TEXT NOT NULL,
        completed_at_utc TEXT,
        rollback_available INTEGER DEFAULT 1,
        details_json TEXT
      );
    `);
  }

  isDuplicate(payloadId) {
    const stmt = this.db.prepare(`
      SELECT payload_id FROM processed_payloads WHERE payload_id = ?
    `);
    const row = stmt.get(payloadId);
    return !!row;
  }

  recordPayload(payload, ingestedAt = new Date().toISOString()) {
    // 1. Mark processed for deduplication
    const dedupStmt = this.db.prepare(`
      INSERT INTO processed_payloads (payload_id, tenant_id, ingested_at_utc, event_timestamp_utc)
      VALUES (?, ?, ?, ?)
    `);
    dedupStmt.run(payload.payload_id, payload.tenant_id, ingestedAt, payload.timestamp_utc);

    // 2. Insert telemetry record ordered by event_timestamp_utc
    const m = payload.metrics || {};
    const telStmt = this.db.prepare(`
      INSERT INTO telemetry_metadata (
        payload_id, tenant_id, collector_id, pseudonym_source_id,
        event_timestamp_utc, source_tz, source_type,
        cpu_percent, memory_percent, disk_io_percent,
        latency_ms, packet_loss_percent, bandwidth_mbps, error_rate_percent,
        health_indicator, event_category, severity, alert_context,
        security_summary_json, redaction_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    telStmt.run(
      payload.payload_id,
      payload.tenant_id,
      payload.collector_id,
      payload.pseudonym_source_id || 'node-anon',
      payload.timestamp_utc,
      payload.source_tz || 'UTC',
      payload.source_type || 'INFRASTRUCTURE',
      m.cpu_percent !== undefined ? m.cpu_percent : null,
      m.memory_percent !== undefined ? m.memory_percent : null,
      m.disk_io_percent !== undefined ? m.disk_io_percent : null,
      m.latency_ms !== undefined ? m.latency_ms : null,
      m.packet_loss_percent !== undefined ? m.packet_loss_percent : null,
      m.bandwidth_mbps !== undefined ? m.bandwidth_mbps : null,
      m.error_rate_percent !== undefined ? m.error_rate_percent : null,
      payload.health_indicator || 'GOOD',
      payload.event_category || 'METRIC_TICK',
      payload.severity || 'INFO',
      payload.alert_context || '',
      payload.security_summary ? JSON.stringify(payload.security_summary) : null,
      payload.redaction_count || 0
    );
  }

  getRecentTelemetry(tenantId, limit = 50) {
    const stmt = this.db.prepare(`
      SELECT * FROM telemetry_metadata
      WHERE tenant_id = ?
      ORDER BY event_timestamp_utc DESC
      LIMIT ?
    `);
    return stmt.all(tenantId, limit);
  }

  getMetricsTimeseries(tenantId, limit = 30) {
    // Return in chronological order for graphs
    const stmt = this.db.prepare(`
      SELECT event_timestamp_utc, cpu_percent, memory_percent, latency_ms, packet_loss_percent, health_indicator
      FROM telemetry_metadata
      WHERE tenant_id = ? AND source_type != 'HEARTBEAT'
      ORDER BY event_timestamp_utc DESC
      LIMIT ?
    `);
    const rows = stmt.all(tenantId, limit);
    return rows.reverse();
  }

  logHealthTransition(tenantId, previousState, newState, reason) {
    const stmt = this.db.prepare(`
      INSERT INTO health_transitions (tenant_id, previous_state, new_state, reason, timestamp_utc)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(tenantId, previousState, newState, reason, new Date().toISOString());
  }

  getHealthTransitions(tenantId, limit = 15) {
    const stmt = this.db.prepare(`
      SELECT * FROM health_transitions
      WHERE tenant_id = ?
      ORDER BY timestamp_utc DESC
      LIMIT ?
    `);
    return stmt.all(tenantId, limit);
  }

  logAutonomousAction(action) {
    const stmt = this.db.prepare(`
      INSERT INTO autonomous_audit_log (
        action_id, tenant_id, incident_id, action_name, target_component,
        status, approved_by, initiated_at_utc, completed_at_utc, rollback_available, details_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      action.action_id,
      action.tenant_id,
      action.incident_id,
      action.action_name,
      action.target_component,
      action.status,
      action.approved_by || 'Awaiting Approval',
      action.initiated_at_utc,
      action.completed_at_utc || null,
      action.rollback_available ? 1 : 0,
      JSON.stringify(action.details || {})
    );
  }

  updateAutonomousAction(actionId, updates) {
    const stmt = this.db.prepare(`
      UPDATE autonomous_audit_log
      SET status = ?, approved_by = ?, completed_at_utc = ?
      WHERE action_id = ?
    `);
    stmt.run(updates.status, updates.approved_by, updates.completed_at_utc || new Date().toISOString(), actionId);
  }

  getAutonomousActions(tenantId, limit = 20) {
    const stmt = this.db.prepare(`
      SELECT * FROM autonomous_audit_log
      WHERE tenant_id = ?
      ORDER BY initiated_at_utc DESC
      LIMIT ?
    `);
    return stmt.all(tenantId, limit);
  }
}
