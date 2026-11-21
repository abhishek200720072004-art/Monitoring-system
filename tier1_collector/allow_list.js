/**
 * Strict Field Allow-List Policy for Tier 1 Collector
 * Deny-by-default: only approved metadata fields can leave the customer boundary.
 */

export const ALLOWED_METADATA_FIELDS = new Set([
  'payload_id',            // string (UUIDv4)
  'tenant_id',             // string
  'collector_id',          // string
  'collector_version',     // string
  'timestamp_utc',         // ISO 8601 string
  'source_tz',             // string, e.g. "UTC", "Asia/Kolkata"
  'source_type',           // "INFRASTRUCTURE" | "NETWORK" | "APPLICATION" | "SECURITY" | "HEARTBEAT"
  'pseudonym_source_id',   // string, e.g. "node-b91c4d"
  'metrics',               // object with numeric values only
  'health_indicator',      // "EXCELLENT" | "GOOD" | "FAIR" | "POOR"
  'event_category',        // string enum
  'severity',              // "INFO" | "WARNING" | "CRITICAL"
  'alert_context',         // sanitized string identifier
  'security_summary',      // object: { failed_attempts, window_sec, risk_score }
  'redaction_count',       // integer
  'queue_backlog_count'    // integer
]);

export const ALLOWED_METRIC_KEYS = new Set([
  'cpu_percent',
  'memory_percent',
  'disk_io_percent',
  'latency_ms',
  'packet_loss_percent',
  'bandwidth_mbps',
  'error_rate_percent',
  'active_connections',
  'http_response_time_ms'
]);

/**
 * Filters a raw object and returns ONLY allow-listed metadata fields.
 * Any non-allowlisted keys (e.g. raw logs, stack traces, credentials, query text)
 * are discarded.
 */
export function enforceAllowList(rawPayload) {
  if (!rawPayload || typeof rawPayload !== 'object') {
    throw new Error('Payload must be an object');
  }

  const sanitized = {};
  const droppedKeys = [];

  for (const [key, value] of Object.entries(rawPayload)) {
    if (ALLOWED_METADATA_FIELDS.has(key)) {
      if (key === 'metrics' && value && typeof value === 'object') {
        // Enforce allowed numeric metrics only
        const cleanMetrics = {};
        for (const [mKey, mVal] of Object.entries(value)) {
          if (ALLOWED_METRIC_KEYS.has(mKey) && typeof mVal === 'number' && !isNaN(mVal)) {
            cleanMetrics[mKey] = Math.round(mVal * 100) / 100;
          } else {
            droppedKeys.push(`metrics.${mKey}`);
          }
        }
        sanitized.metrics = cleanMetrics;
      } else if (key === 'security_summary' && value && typeof value === 'object') {
        sanitized.security_summary = {
          failed_attempts: Number(value.failed_attempts) || 0,
          window_sec: Number(value.window_sec) || 60,
          risk_score: Number(value.risk_score) || 0
        };
      } else {
        sanitized[key] = value;
      }
    } else {
      droppedKeys.push(key);
    }
  }

  // Ensure mandatory fields exist
  if (!sanitized.payload_id) {
    throw new Error('Allow-list enforcement failed: missing payload_id');
  }
  if (!sanitized.timestamp_utc) {
    sanitized.timestamp_utc = new Date().toISOString();
  }
  if (!sanitized.source_tz) {
    sanitized.source_tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }

  return {
    sanitized,
    droppedKeys
  };
}
