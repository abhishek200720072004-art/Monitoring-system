export class FourStateHealthEvaluator {
  constructor(storage) {
    this.storage = storage;
    this.tenantStates = new Map(); // tenantId -> { state, reason, lastSeenUtc, collectorId }
    this.watchdogInterval = null;
  }

  startWatchdog() {
    // Check for stale collectors every 5 seconds
    this.watchdogInterval = setInterval(() => this.evaluateStaleCollectors(), 5000);
  }

  stopWatchdog() {
    if (this.watchdogInterval) clearInterval(this.watchdogInterval);
  }

  evaluateIncomingTelemetry(payload) {
    const tenantId = payload.tenant_id;
    const collectorId = payload.collector_id;
    const m = payload.metrics || {};
    const now = new Date();

    const currentInfo = this.tenantStates.get(tenantId) || {
      state: 'EXCELLENT',
      reason: 'System newly initialized',
      lastSeenUtc: now.toISOString(),
      collectorId
    };

    let calculatedState = 'EXCELLENT';
    let reasons = [];

    // Rule 1: High severity / Critical conditions
    if (payload.severity === 'CRITICAL') {
      calculatedState = 'POOR';
      reasons.push(payload.alert_context || 'Critical severity alert flagged');
    }

    // Rule 2: Metric thresholds
    if (m.cpu_percent >= 92) {
      calculatedState = 'POOR';
      reasons.push(`Critical CPU saturation (${m.cpu_percent}%)`);
    } else if (m.cpu_percent >= 75 && calculatedState !== 'POOR') {
      calculatedState = 'FAIR';
      reasons.push(`Elevated CPU usage (${m.cpu_percent}%)`);
    }

    if (m.memory_percent >= 92) {
      calculatedState = 'POOR';
      reasons.push(`Critical memory pressure (${m.memory_percent}%)`);
    } else if (m.memory_percent >= 80 && calculatedState !== 'POOR') {
      calculatedState = 'FAIR';
      reasons.push(`Elevated memory utilization (${m.memory_percent}%)`);
    }

    if (m.latency_ms >= 250) {
      calculatedState = 'POOR';
      reasons.push(`Severe network latency degradation (${m.latency_ms}ms)`);
    } else if (m.latency_ms >= 75 && calculatedState !== 'POOR') {
      calculatedState = 'FAIR';
      reasons.push(`Elevated network latency (${m.latency_ms}ms)`);
    }

    if (m.packet_loss_percent >= 8.0) {
      calculatedState = 'POOR';
      reasons.push(`Excessive packet loss (${m.packet_loss_percent}%)`);
    } else if (m.packet_loss_percent >= 2.0 && calculatedState !== 'POOR') {
      calculatedState = 'FAIR';
      reasons.push(`Minor packet loss detected (${m.packet_loss_percent}%)`);
    }

    // Rule 3: Security brute-force signals
    if (payload.event_category === 'SECURITY_BURST_ALERT') {
      calculatedState = 'POOR';
      reasons.push(`Repeated authentication failure burst (${payload.security_summary?.failed_attempts || 0} attempts)`);
    }

    // Rule 4: Normal deviation (GOOD)
    if (calculatedState === 'EXCELLENT' && (m.cpu_percent > 60 || m.latency_ms > 40)) {
      calculatedState = 'GOOD';
      reasons.push('Minor variance within acceptable operational thresholds');
    }

    const finalReason = reasons.length > 0 ? reasons.join('; ') : 'All telemetry within healthy baseline';

    // State transition check
    if (currentInfo.state !== calculatedState) {
      this.storage.logHealthTransition(tenantId, currentInfo.state, calculatedState, finalReason);
    }

    const updated = {
      state: calculatedState,
      reason: finalReason,
      lastSeenUtc: now.toISOString(),
      lastSeenMs: now.getTime(),
      collectorId
    };

    this.tenantStates.set(tenantId, updated);
    return updated;
  }

  evaluateStaleCollectors() {
    const now = Date.now();
    for (const [tenantId, info] of this.tenantStates.entries()) {
      const elapsedSec = Math.floor((now - (info.lastSeenMs || 0)) / 1000);

      // Stale data detection rule:
      // If no telemetry or heartbeat received in > 60 seconds -> downgrade to POOR
      if (elapsedSec >= 60 && info.state !== 'POOR') {
        const reason = `Collector offline / Heartbeat missing for ${elapsedSec}s (Target: <60s)`;
        this.storage.logHealthTransition(tenantId, info.state, 'POOR', reason);
        info.state = 'POOR';
        info.reason = reason;
      } else if (elapsedSec >= 25 && elapsedSec < 60 && info.state === 'EXCELLENT') {
        const reason = `Collector heartbeat delayed (${elapsedSec}s since last report)`;
        this.storage.logHealthTransition(tenantId, info.state, 'FAIR', reason);
        info.state = 'FAIR';
        info.reason = reason;
      }
    }
  }

  getTenantHealth(tenantId) {
    const info = this.tenantStates.get(tenantId);
    if (!info) {
      return {
        state: 'EXCELLENT',
        reason: 'Awaiting collector connection',
        lastSeenUtc: new Date().toISOString(),
        elapsedSec: 0
      };
    }
    const elapsedSec = Math.floor((Date.now() - (info.lastSeenMs || Date.now())) / 1000);
    return {
      state: info.state,
      reason: info.reason,
      lastSeenUtc: info.lastSeenUtc,
      elapsedSec,
      collectorId: info.collectorId
    };
  }
}
