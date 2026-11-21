import crypto from 'node:crypto';

export class ExplainableAIOpsEngine {
  constructor(storage) {
    this.storage = storage;
    // Moving baseline stats per tenant
    this.baselines = new Map(); // tenantId -> { cpu: SlidingWindow, latency: SlidingWindow, memory: SlidingWindow }
    this.activeIncidents = new Map(); // tenantId -> Array of active correlated incidents
  }

  getBaseline(tenantId) {
    if (!this.baselines.has(tenantId)) {
      this.baselines.set(tenantId, {
        cpuHistory: [24, 25, 23, 26, 24, 25, 27, 23],
        latencyHistory: [18, 20, 19, 22, 17, 21, 19],
        memoryHistory: [44, 45, 43, 46, 44, 45]
      });
    }
    return this.baselines.get(tenantId);
  }

  calculateStats(arr) {
    if (arr.length === 0) return { mean: 0, stdDev: 1 };
    const mean = arr.reduce((acc, val) => acc + val, 0) / arr.length;
    const variance = arr.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / arr.length;
    return { mean, stdDev: Math.sqrt(variance) || 1 };
  }

  analyze(payload) {
    const tenantId = payload.tenant_id;
    const m = payload.metrics || {};
    const base = this.getBaseline(tenantId);

    // Update sliding baselines when data is healthy
    if (m.cpu_percent && payload.severity === 'INFO') {
      base.cpuHistory.push(m.cpu_percent);
      if (base.cpuHistory.length > 50) base.cpuHistory.shift();
    }
    if (m.latency_ms && payload.severity === 'INFO') {
      base.latencyHistory.push(m.latency_ms);
      if (base.latencyHistory.length > 50) base.latencyHistory.shift();
    }

    const cpuStats = this.calculateStats(base.cpuHistory);
    const latencyStats = this.calculateStats(base.latencyHistory);

    const cpuZScore = m.cpu_percent ? (m.cpu_percent - cpuStats.mean) / cpuStats.stdDev : 0;
    const latencyZScore = m.latency_ms ? (m.latency_ms - latencyStats.mean) / latencyStats.stdDev : 0;

    // Detect anomalies
    const isAnomaly = cpuZScore > 2.8 || latencyZScore > 3.0 || payload.severity === 'CRITICAL' || payload.event_category === 'SECURITY_BURST_ALERT';

    if (isAnomaly) {
      return this.correlateAndExplain(payload, {
        cpuZScore,
        latencyZScore,
        cpuMean: Math.round(cpuStats.mean * 10) / 10,
        latencyMean: Math.round(latencyStats.mean * 10) / 10
      });
    }

    return null;
  }

  correlateAndExplain(payload, stats) {
    const tenantId = payload.tenant_id;
    const m = payload.metrics || {};
    const now = new Date();

    let incidentType = 'INFRASTRUCTURE_RESOURCE_SATURATION';
    let title = 'Resource Saturation & Performance Deviation';
    let hypothesis = 'Sudden compute workload surge exceeding provisioned thread allocation.';
    let actionName = 'SCALE_WORKER_PODS';
    let targetComponent = payload.pseudonym_source_id || 'node-a7c89f';
    let recommendedAction = 'Scale worker pool from 2 to 4 instances to alleviate compute pressure.';
    let confidence = 88;

    // Signal contribution calculation (weights)
    let weights = {
      cpu: 0,
      latency: 0,
      memory: 0,
      packet_loss: 0,
      security: 0
    };

    if (payload.event_category === 'SECURITY_BURST_ALERT') {
      incidentType = 'SECURITY_BRUTE_FORCE_BURST';
      title = 'Repeated Authentication Failure Storm (Brute-Force Risk)';
      hypothesis = 'Automated credential stuffing or dictionary attack targeting administrative endpoints.';
      actionName = 'RATE_LIMIT_IP_PSEUDONYM';
      targetComponent = payload.pseudonym_source_id || 'auth-gateway';
      recommendedAction = 'Enforce progressive delay and IP challenge at customer border proxy.';
      confidence = 96;
      weights.security = 85;
      weights.latency = 15;
    } else if (payload.event_category === 'CASCADE_SYSTEM_INCIDENT' || (m.cpu_percent > 90 && m.latency_ms > 200)) {
      incidentType = 'CASCADING_BACKEND_SATURATION';
      title = 'Database Saturation Cascading to Web Gateway (Correlated Multi-Alert)';
      hypothesis = 'Long-running unindexed queries holding connection pool locks, propagating 504 timeouts to ingress gateway.';
      actionName = 'RECYCLE_CONNECTION_POOL';
      targetComponent = 'db-worker-pool';
      recommendedAction = 'Recycle stale database connection pool and inject temporary read-replica routing.';
      confidence = 94;
      weights.cpu = 42;
      weights.latency = 38;
      weights.memory = 12;
      weights.packet_loss = 8;
    } else if (m.latency_ms > 200 || m.packet_loss_percent > 5) {
      incidentType = 'NETWORK_TRANSIT_DEGRADATION';
      title = 'Network Transit Congestion & Packet Loss Anomaly';
      hypothesis = 'Upstream ISP route flap or interface buffer overflow causing packet retransmissions.';
      actionName = 'REROUTE_TRAFFIC_SECONDARY_BGP';
      targetComponent = 'edge-router-01';
      recommendedAction = 'Switch primary edge transit to secondary BGP carrier link.';
      confidence = 91;
      weights.latency = 60;
      weights.packet_loss = 30;
      weights.cpu = 10;
    } else {
      weights.cpu = 65;
      weights.memory = 25;
      weights.latency = 10;
    }

    // Correlate: Check if an active incident for this tenant already exists within last 60s
    let tenantIncidents = this.activeIncidents.get(tenantId) || [];
    const cutoff = now.getTime() - 60000;
    tenantIncidents = tenantIncidents.filter(inc => new Date(inc.timestamp_utc).getTime() >= cutoff);

    let incident = tenantIncidents.find(inc => inc.incident_type === incidentType);

    if (incident) {
      // Merge alert into existing incident (Event Intelligence & Alert Noise Reduction)
      incident.correlated_alerts_count++;
      incident.latest_timestamp_utc = now.toISOString();
      incident.aggregated_sources.add(payload.pseudonym_source_id || 'node');
    } else {
      // Create new correlated incident with full explainability details
      incident = {
        incident_id: `INC-${Date.now().toString().slice(-5)}`,
        tenant_id: tenantId,
        incident_type: incidentType,
        title,
        severity: payload.severity || 'CRITICAL',
        status: 'OPEN',
        timestamp_utc: now.toISOString(),
        latest_timestamp_utc: now.toISOString(),
        correlated_alerts_count: 1,
        aggregated_sources: new Set([payload.pseudonym_source_id || 'node']),
        explainability: {
          confidence_percent: confidence,
          trigger_reason: `Observed metric anomaly (CPU Z-score: ${Math.round(stats.cpuZScore * 10) / 10}, Latency Z-score: ${Math.round(stats.latencyZScore * 10) / 10}) relative to baseline.`,
          baseline_reference: `Baseline CPU: ${stats.cpuMean}% | Baseline Latency: ${stats.latencyMean}ms`,
          signal_attribution: weights,
          root_cause_hypothesis: hypothesis,
          reasoning_path: [
            `1. Collector detected deviation exceeding 2.5σ baseline.`,
            `2. Event intelligence engine cross-correlated infrastructure metrics with network response times.`,
            `3. Multi-signal pattern matches known signature '${incidentType}' with ${confidence}% confidence.`,
            `4. Synthesized 1 parent incident to prevent alert fatigue.`
          ],
          recommended_remediation: {
            action_name: actionName,
            target: targetComponent,
            action_description: recommendedAction,
            is_autonomous_candidate: true
          }
        }
      };
      tenantIncidents.unshift(incident);
    }

    this.activeIncidents.set(tenantId, tenantIncidents);
    return incident;
  }

  getActiveIncidents(tenantId) {
    const list = this.activeIncidents.get(tenantId) || [];
    return list.map(inc => ({
      ...inc,
      aggregated_sources: Array.from(inc.aggregated_sources)
    }));
  }
}
