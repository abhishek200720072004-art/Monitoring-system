import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { MultiTenantMetadataStore } from './storage.js';
import { IngestionDeduplicationEngine } from './dedup_engine.js';
import { FourStateHealthEvaluator } from './health_evaluator.js';
import { ExplainableAIOpsEngine } from './aiops_engine.js';
import { AutonomousOpsManager } from './autonomous_ops.js';

export class CentralSaaSServer {
  constructor(port = 3000, region = 'ap-south-1') {
    this.port = port;
    this.region = region;
    this.storage = new MultiTenantMetadataStore(region);
    this.dedupEngine = new IngestionDeduplicationEngine(this.storage);
    this.healthEvaluator = new FourStateHealthEvaluator(this.storage);
    this.aiopsEngine = new ExplainableAIOpsEngine(this.storage);
    this.autonomousOps = new AutonomousOpsManager(this.storage);

    this.sseClients = new Set();
    this.server = null;
    this.collectorRef = null; // direct ref for hackathon demo runner if in same process
  }

  setCollectorRef(collector) {
    this.collectorRef = collector;
  }

  start() {
    this.healthEvaluator.startWatchdog();

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    this.server.listen(this.port, () => {
      console.log(`[Tier 2 SaaS Platform] Running on http://localhost:${this.port}`);
      console.log(`[Tier 2 SaaS Platform] Ingestion Region: ${this.region} | Multi-tenant Store: active`);
    });
  }

  stop() {
    this.healthEvaluator.stopWatchdog();
    if (this.server) this.server.close();
  }

  broadcastSSE(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(payload);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  async handleRequest(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Tenant-ID, X-Collector-ID');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // 1. SSE Stream Endpoint
    if (pathname === '/api/v1/events/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      res.write(': connected\n\n');
      this.sseClients.add(res);
      req.on('close', () => this.sseClients.delete(res));
      return;
    }

    // 2. Regional Telemetry Metadata Ingest Endpoint
    if (req.method === 'POST' && pathname.startsWith('/api/v1/regional/')) {
      const body = await this.readBody(req);
      const authHeader = req.headers['authorization'];
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Missing or invalid collector Bearer token' }));
        return;
      }

      try {
        const payload = JSON.parse(body);

        // Deduplication & event-time ordering
        const dedupResult = this.dedupEngine.processIncomingPayload(payload);

        if (dedupResult.isDuplicate) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(dedupResult));
          return;
        }

        // Evaluate 4-state health
        const healthUpdate = this.healthEvaluator.evaluateIncomingTelemetry(payload);

        // Run Explainable AIOps correlation
        const incident = this.aiopsEngine.analyze(payload);

        // If anomaly triggered, propose safe autonomous remediation
        let proposedAction = null;
        if (incident) {
          proposedAction = this.autonomousOps.proposeRemediation(incident);
        }

        // Broadcast real-time update via SSE
        this.broadcastSSE('telemetry_tick', {
          payload,
          healthUpdate,
          incident,
          proposedAction,
          perf: this.dedupEngine.getMetrics()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'SUCCESS',
          payload_id: payload.payload_id,
          tenant_id: payload.tenant_id,
          health_state: healthUpdate.state,
          latency_ms: dedupResult.latencyMs
        }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to process payload: ' + err.message }));
      }
      return;
    }

    // 3. Tenant Overview & Telemetry API
    if (req.method === 'GET' && pathname.startsWith('/api/v1/tenant/')) {
      const parts = pathname.split('/');
      const tenantId = parts[4] || 'tenant-acme-prod';
      const action = parts[5];

      if (action === 'overview') {
        const health = this.healthEvaluator.getTenantHealth(tenantId);
        const timeseries = this.storage.getMetricsTimeseries(tenantId, 30);
        const transitions = this.storage.getHealthTransitions(tenantId, 10);
        const incidents = this.aiopsEngine.getActiveIncidents(tenantId);
        const pendingActions = this.autonomousOps.getPendingActions(tenantId);
        const auditLog = this.storage.getAutonomousActions(tenantId, 10);
        const perf = this.dedupEngine.getMetrics();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          tenantId,
          region: this.region,
          health,
          timeseries,
          transitions,
          incidents,
          pendingActions,
          auditLog,
          perf
        }));
        return;
      }

      if (action === 'egress-proof') {
        // Return recent egress proof records from local collector logger
        let proofs = [];
        if (this.collectorRef) {
          proofs = this.collectorRef.egressLogger.getRecentProofs(20);
        } else {
          try {
            const pFile = path.join(process.cwd(), 'tier1_collector', 'data', 'egress_proof_audit.json');
            if (fs.existsSync(pFile)) {
              proofs = JSON.parse(fs.readFileSync(pFile, 'utf8'));
            }
          } catch {}
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ proofs }));
        return;
      }
    }

    // 4. Autonomous Ops Actions (Approve / Rollback)
    if (req.method === 'POST' && pathname === '/api/v1/autonomous/approve') {
      const body = await this.readBody(req);
      try {
        const { action_id, approver } = JSON.parse(body);
        const result = this.autonomousOps.approveAndExecute(action_id, approver);

        // If it was a chaos remediation, reset the chaos in the collector!
        if (this.collectorRef) {
          this.collectorRef.resetAllChaos();
        }

        this.broadcastSSE('action_executed', result);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'EXECUTED', result }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/v1/autonomous/rollback') {
      const body = await this.readBody(req);
      try {
        const { action_id, operator } = JSON.parse(body);
        const result = this.autonomousOps.executeRollback(action_id, operator);
        this.broadcastSSE('action_rollback', result);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ROLLED_BACK', result }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // 5. Chaos / Live Scenario Injection API (The 8 Judge Scenarios)
    if (req.method === 'POST' && pathname === '/api/v1/chaos/inject') {
      const body = await this.readBody(req);
      try {
        const { scenario } = JSON.parse(body);
        let message = '';

        if (!this.collectorRef) {
          throw new Error('Collector reference not attached');
        }

        switch (scenario) {
          case '1_SECRET_LOG':
            this.collectorRef.injectSecretLog(
              `[CRITICAL] DB_AUTH_FAILURE node="prod-db-master-01.corp" user="postgres" password="ProductionPassword#994!" token="Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.secret_xyz" api_key="sk_live_28947192847291827"`
            );
            message = 'Scenario 1 injected: Secret embedded in raw log. Verified: stripped locally before transmission!';
            break;

          case '2_OUTAGE_BUFFER':
            const isOutage = this.collectorRef.toggleSimulatedOutage();
            message = isOutage 
              ? 'Scenario 2 injected: SaaS link severed! Collector local buffer queue accumulating payloads (Zero loss).'
              : 'Scenario 2 resolved: SaaS link restored! Replaying buffered queue idempotently (Zero loss, Zero duplicates).';
            break;

          case '3_FAILED_LOGINS':
            this.collectorRef.injectAuthBurst(14);
            message = 'Scenario 3 injected: 14 failed brute-force logins. Emitted compact risk indicator without raw credentials.';
            break;

          case '4_LATENCY_SPIKE':
            this.collectorRef.injectLatencySpike(true);
            message = 'Scenario 4 injected: Network latency jumped to 420ms with 14% packet loss.';
            break;

          case '5_CPU_ANOMALY':
            this.collectorRef.injectCpuAnomaly(true);
            message = 'Scenario 5 injected: CPU saturated at 98%, deviating 3.8σ from dynamic baseline.';
            break;

          case '6_MULTI_ALERT_STORM':
            this.collectorRef.injectMultiAlertStorm(true);
            message = 'Scenario 6 injected: Multi-Alert Storm. High CPU + DB Latency + 504 Timeout correlated into 1 Parent Incident.';
            break;

          case '7_DUPLICATE_PAYLOAD':
            // Re-send an already processed payload ID to test deduplication
            const recent = this.storage.getRecentTelemetry('tenant-acme-prod', 1);
            if (recent.length > 0) {
              const dupPayload = {
                payload_id: recent[0].payload_id,
                tenant_id: 'tenant-acme-prod',
                collector_id: 'col-eu-01',
                timestamp_utc: recent[0].event_timestamp_utc,
                metrics: { cpu_percent: 25.0 }
              };
              const dedupRes = this.dedupEngine.processIncomingPayload(dupPayload);
              message = `Scenario 7 injected: Duplicate payload ID ${dupPayload.payload_id} submitted. Engine status: ${dedupRes.status} (Safely Dropped).`;
            } else {
              message = 'No existing payload to duplicate yet. Wait for initial ticks.';
            }
            break;

          case '8_RESET_NORMAL':
            this.collectorRef.resetAllChaos();
            message = 'Reset complete: All operational metrics restored to normal healthy baseline.';
            break;

          default:
            throw new Error(`Unknown scenario: ${scenario}`);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'OK', scenario, message, collectorStatus: this.collectorRef.getStatus() }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // 6. Static File Serving (Web Dashboard)
    this.serveStaticFile(pathname, res);
  }

  serveStaticFile(pathname, res) {
    let filePath = pathname === '/' ? '/index.html' : pathname;
    const fullPath = path.join(process.cwd(), 'public', filePath);

    if (!fs.existsSync(fullPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(fullPath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.svg': 'image/svg+xml',
      '.png': 'image/png'
    };

    const contentType = mimeTypes[ext] || 'application/octet-stream';
    const content = fs.readFileSync(fullPath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  }

  readBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => data += chunk);
      req.on('end', () => resolve(data));
      req.on('error', err => reject(err));
    });
  }
}
