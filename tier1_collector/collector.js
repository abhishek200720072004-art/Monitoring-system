import crypto from 'node:crypto';
import { scrubRawContent, pseudonymizeIdentifier } from './scrubber.js';
import { enforceAllowList } from './allow_list.js';
import { LocalBufferQueue } from './local_buffer.js';
import { LocalSecurityDetector } from './local_security.js';
import { EgressProofLogger } from './egress_logger.js';
import { TelemetryGenerator } from './telemetry_generator.js';

export class LocalCollectorDaemon {
  constructor(options = {}) {
    this.collectorId = options.collectorId || 'col-eu-01';
    this.tenantId = options.tenantId || 'tenant-acme-prod';
    this.version = 'v2.4.0-cicada';
    this.region = options.region || 'ap-south-1';
    this.saasEndpoint = options.saasEndpoint || 'http://localhost:3000/api/v1/regional/ap-south-1/ingest';
    this.authToken = options.authToken || 'col_sec_token_cicada_99182a';
    this.sourceTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';

    this.buffer = new LocalBufferQueue();
    this.securityDetector = new LocalSecurityDetector();
    this.egressLogger = new EgressProofLogger();
    this.generator = new TelemetryGenerator();

    this.isSaasOnline = true;
    this.simulatedOutage = false;
    this.totalSent = 0;
    this.totalBuffered = 0;
    this.totalAcked = 0;
    this.startTime = Date.now();

    this.tickInterval = null;
    this.deliveryInterval = null;
    this.heartbeatInterval = null;
  }

  start() {
    console.log(`[Collector ${this.collectorId}] Starting Tier 1 Local Collector Daemon...`);
    console.log(`[Collector ${this.collectorId}] Regional Ingest Target: ${this.saasEndpoint}`);
    console.log(`[Collector ${this.collectorId}] Tenant ID: ${this.tenantId} | TimeZone: ${this.sourceTz}`);

    // Telemetry generation loop (every 2.5 seconds)
    this.tickInterval = setInterval(() => this.collectAndProcessTick(), 2500);

    // Delivery transmission loop (every 1.5 seconds)
    this.deliveryInterval = setInterval(() => this.flushDeliveryQueue(), 1500);

    // Heartbeat loop (every 10 seconds)
    this.heartbeatInterval = setInterval(() => this.sendHeartbeat(), 10000);

    // Immediate first tick & heartbeat
    this.collectAndProcessTick();
    this.sendHeartbeat();
  }

  stop() {
    if (this.tickInterval) clearInterval(this.tickInterval);
    if (this.deliveryInterval) clearInterval(this.deliveryInterval);
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
  }

  collectAndProcessTick() {
    try {
      const rawData = this.generator.generateRawTick();

      // 1. Scrub and redact any raw logs / payloads
      const { scrubbedText, redactionCount, detectedTypes } = scrubRawContent(rawData.rawLogSample);

      // 2. Pseudonymize hostname
      const pseudonymNode = pseudonymizeIdentifier(rawData.rawHostname);

      // 3. Determine local health indicator
      const m = rawData.metrics;
      let healthIndicator = 'EXCELLENT';
      if (m.cpu_percent > 90 || m.memory_percent > 90 || m.latency_ms > 300 || m.packet_loss_percent > 10) {
        healthIndicator = 'POOR';
      } else if (m.cpu_percent > 75 || m.memory_percent > 80 || m.latency_ms > 100 || m.packet_loss_percent > 2) {
        healthIndicator = 'FAIR';
      } else if (m.cpu_percent > 60 || m.latency_ms > 50) {
        healthIndicator = 'GOOD';
      }

      // Check for security signals from local detector
      const securityEval = this.securityDetector.evaluateSecuritySignals();
      if (securityEval.isAlert && healthIndicator !== 'POOR') {
        healthIndicator = 'FAIR';
      }

      const payloadId = crypto.randomUUID();
      const timestampUtc = new Date().toISOString();

      // Construct raw metadata payload candidate
      const candidatePayload = {
        payload_id: payloadId,
        tenant_id: this.tenantId,
        collector_id: this.collectorId,
        collector_version: this.version,
        timestamp_utc: timestampUtc,
        source_tz: this.sourceTz,
        source_type: 'INFRASTRUCTURE',
        pseudonym_source_id: pseudonymNode,
        metrics: m,
        health_indicator: healthIndicator,
        event_category: securityEval.isAlert ? 'SECURITY_BURST_ALERT' : rawData.eventCategory,
        severity: securityEval.isAlert ? securityEval.severity : rawData.severity,
        alert_context: securityEval.isAlert ? securityEval.alertContext : rawData.alertContext,
        security_summary: securityEval.summary,
        redaction_count: redactionCount,
        queue_backlog_count: this.buffer.getBacklogCount(),
        // Raw internal fields to verify that allow-list drops them:
        _internal_raw_log: rawData.rawLogSample,
        _internal_node_ip: '192.168.1.104',
        _internal_stack_trace: 'Traceback at /var/app/db.py:92'
      };

      // 4. Enforce strict allow-list policy
      const { sanitized, droppedKeys } = enforceAllowList(candidatePayload);

      // 5. Log to Egress Proof Logger (Local visibility only!)
      this.egressLogger.logProof({
        payloadId,
        rawInputSample: {
          hostname: rawData.rawHostname,
          rawLog: rawData.rawLogSample,
          detectedSecrets: detectedTypes,
          unredactedMetrics: rawData.metrics
        },
        egressPayload: sanitized,
        redactionCount,
        detectedSecretTypes: detectedTypes,
        droppedKeys
      });

      // 6. Enqueue sanitized payload into local SQLite persistent buffer
      this.buffer.enqueue(sanitized);
      this.totalBuffered++;
    } catch (err) {
      console.error('[Collector] Error during collectAndProcessTick:', err.message);
    }
  }

  sendHeartbeat() {
    try {
      const payloadId = crypto.randomUUID();
      const heartbeatPayload = {
        payload_id: payloadId,
        tenant_id: this.tenantId,
        collector_id: this.collectorId,
        collector_version: this.version,
        timestamp_utc: new Date().toISOString(),
        source_tz: this.sourceTz,
        source_type: 'HEARTBEAT',
        pseudonym_source_id: 'collector-host',
        metrics: {
          cpu_percent: Math.round((process.cpuUsage().user / 1000000) * 10) / 10,
          memory_percent: Math.round((process.memoryUsage().heapUsed / (1024 * 1024)) * 10) / 10
        },
        health_indicator: this.buffer.getBacklogCount() > 20 ? 'FAIR' : 'EXCELLENT',
        event_category: 'HEARTBEAT',
        severity: 'INFO',
        alert_context: 'collector_healthy',
        queue_backlog_count: this.buffer.getBacklogCount()
      };

      const { sanitized } = enforceAllowList(heartbeatPayload);
      this.buffer.enqueue(sanitized);
    } catch (err) {
      console.error('[Collector] Error generating heartbeat:', err.message);
    }
  }

  async flushDeliveryQueue() {
    if (this.simulatedOutage) {
      this.isSaasOnline = false;
      return; // Do not attempt transmission during simulated outage
    }

    const batch = this.buffer.peekBatch(20);
    if (!batch || batch.length === 0) return;

    for (const item of batch) {
      try {
        this.buffer.markAttempt(item.payload_id);
        const res = await fetch(this.saasEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.authToken}`,
            'X-Tenant-ID': item.tenant_id,
            'X-Collector-ID': this.collectorId
          },
          body: JSON.stringify(item.payload),
          signal: AbortSignal.timeout(3000)
        });

        if (res.ok) {
          const respData = await res.json().catch(() => ({}));
          this.buffer.ack(item.payload_id);
          this.totalAcked++;
          this.isSaasOnline = true;
        } else {
          console.warn(`[Collector] Ingestion returned HTTP ${res.status}`);
          this.isSaasOnline = false;
          break; // Stop batch on failure
        }
      } catch (networkErr) {
        // SaaS unreachable
        this.isSaasOnline = false;
        break; // Leave records in local SQLite buffer for retry
      }
    }
  }

  // Chaos controls for live scenarios
  injectSecretLog(customSecret = null) {
    this.generator.setChaos('secretLog', true, customSecret);
    this.collectAndProcessTick(); // immediate execution
  }

  toggleSimulatedOutage(enable = null) {
    if (enable === null) {
      this.simulatedOutage = !this.simulatedOutage;
    } else {
      this.simulatedOutage = enable;
    }
    if (!this.simulatedOutage) {
      // Reconnected! Immediately trigger delivery flush
      this.flushDeliveryQueue();
    }
    return this.simulatedOutage;
  }

  injectAuthBurst(failedCount = 12) {
    for (let i = 0; i < failedCount; i++) {
      this.securityDetector.recordAuthEvent({
        username: i % 2 === 0 ? 'root' : 'admin_svc',
        ip: '192.168.1.189',
        success: false,
        reason: 'Invalid credentials'
      });
    }
    this.collectAndProcessTick();
  }

  injectLatencySpike(enable = true) {
    this.generator.setChaos('latencySpike', enable);
  }

  injectCpuAnomaly(enable = true) {
    this.generator.setChaos('cpuAnomaly', enable);
  }

  injectMultiAlertStorm(enable = true) {
    this.generator.setChaos('multiAlertStorm', enable);
  }

  resetAllChaos() {
    this.simulatedOutage = false;
    this.generator.setChaos('reset');
  }

  getStatus() {
    return {
      collectorId: this.collectorId,
      version: this.version,
      tenantId: this.tenantId,
      region: this.region,
      isSaasOnline: this.isSaasOnline,
      simulatedOutage: this.simulatedOutage,
      backlogCount: this.buffer.getBacklogCount(),
      totalBuffered: this.totalBuffered,
      totalAcked: this.totalAcked,
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000)
    };
  }
}
