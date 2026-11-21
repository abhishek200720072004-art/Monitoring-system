import assert from 'node:assert';
import crypto from 'node:crypto';
import { scrubRawContent, calculateShannonEntropy, pseudonymizeIdentifier } from './tier1_collector/scrubber.js';
import { enforceAllowList } from './tier1_collector/allow_list.js';
import { LocalBufferQueue } from './tier1_collector/local_buffer.js';
import { LocalSecurityDetector } from './tier1_collector/local_security.js';
import { MultiTenantMetadataStore } from './tier2_saas/storage.js';
import { IngestionDeduplicationEngine } from './tier2_saas/dedup_engine.js';
import { FourStateHealthEvaluator } from './tier2_saas/health_evaluator.js';
import { ExplainableAIOpsEngine } from './tier2_saas/aiops_engine.js';
import { AutonomousOpsManager } from './tier2_saas/autonomous_ops.js';

console.log('================================================================');
console.log('   RUNNING AUTOMATED TEST SUITE FOR CICADA 2026 EVALUATION       ');
console.log('================================================================');

// 1. Test Secret Scrubber
console.log('\n[TEST 1] Testing Secret Scrubber & Shannon Entropy Filter...');
const rawSampleWithSecret = 'Error connecting to postgres://admin:SuperSecretPass123@192.168.1.50/prod with key AKIA1234567890ABCDEF';
const scrubResult = scrubRawContent(rawSampleWithSecret);
assert.strictEqual(scrubResult.scrubbedText.includes('SuperSecretPass123'), false, 'Password must be scrubbed');
assert.strictEqual(scrubResult.scrubbedText.includes('AKIA1234567890ABCDEF'), false, 'AWS key must be scrubbed');
assert.ok(scrubResult.redactionCount >= 2, 'Should detect at least 2 secrets');
console.log('✓ Secret scrubber successfully redacted sensitive tokens and credentials.');

// 2. Test Pseudonymization
console.log('\n[TEST 2] Testing Deterministic Pseudonymization...');
const p1 = pseudonymizeIdentifier('internal-db-node.corp');
const p2 = pseudonymizeIdentifier('internal-db-node.corp');
assert.strictEqual(p1, p2, 'Pseudonym must be deterministic');
assert.ok(p1.startsWith('node-'), 'Pseudonym should start with node-');
console.log(`✓ Pseudonymization verified: internal-db-node.corp -> ${p1}`);

// 3. Test Strict Field Allow-Listing
console.log('\n[TEST 3] Testing Deny-by-Default Allow-List Schema...');
const candidate = {
  payload_id: crypto.randomUUID(),
  tenant_id: 'tenant-test',
  collector_id: 'col-01',
  metrics: {
    cpu_percent: 45.2,
    memory_percent: 60.1,
    unapproved_metric_raw_bytes: 999999
  },
  _secret_raw_database_query: 'SELECT * FROM users WHERE ssn IS NOT NULL',
  _internal_ip: '10.0.0.1'
};
const { sanitized, droppedKeys } = enforceAllowList(candidate);
assert.strictEqual(sanitized._secret_raw_database_query, undefined, 'Unapproved raw fields must be dropped');
assert.strictEqual(sanitized._internal_ip, undefined, 'Internal IP must be dropped');
assert.strictEqual(sanitized.metrics.unapproved_metric_raw_bytes, undefined, 'Unapproved metric keys must be dropped');
assert.strictEqual(sanitized.metrics.cpu_percent, 45.2, 'Allowed metrics must be retained');
assert.ok(droppedKeys.length >= 3, 'Dropped keys list must contain dropped fields');
console.log(`✓ Strict allow-list enforced: Dropped non-whitelisted keys [${droppedKeys.join(', ')}]`);

// 4. Test Local SQLite Buffer Queue (WAL Mode)
console.log('\n[TEST 4] Testing Local SQLite Buffer Queue Persistence...');
const buffer = new LocalBufferQueue(':memory:');
const testPayload = {
  payload_id: crypto.randomUUID(),
  tenant_id: 'tenant-test',
  timestamp_utc: new Date().toISOString(),
  metrics: { cpu_percent: 25.0 }
};
buffer.enqueue(testPayload);
assert.strictEqual(buffer.getBacklogCount(), 1, 'Backlog count should be 1');
const batch = buffer.peekBatch(10);
assert.strictEqual(batch.length, 1, 'Batch should contain 1 item');
assert.strictEqual(batch[0].payload_id, testPayload.payload_id, 'Payload ID should match');
buffer.ack(testPayload.payload_id);
assert.strictEqual(buffer.getBacklogCount(), 0, 'Backlog should be 0 after ACK');
console.log('✓ Local SQLite persistent buffer (enqueue -> peek -> ack) verified.');

// 5. Test Local Security Brute Force Detector
console.log('\n[TEST 5] Testing Local Brute-Force Auth Detector...');
const securityDetector = new LocalSecurityDetector();
for (let i = 0; i < 6; i++) {
  securityDetector.recordAuthEvent({
    username: 'admin',
    ip: '192.168.1.200',
    success: false,
    reason: 'Bad password'
  });
}
const secEval = securityDetector.evaluateSecuritySignals();
assert.strictEqual(secEval.isAlert, true, 'Security alert must trigger after 6 failed logins');
assert.strictEqual(secEval.summary.failed_attempts, 6, 'Failed count should be 6');
assert.ok(secEval.summary.risk_score > 0, 'Risk score must be positive');
console.log(`✓ Local security engine triggered risk summary: Risk Score ${secEval.summary.risk_score}, failed attempts ${secEval.summary.failed_attempts}`);

// 6. Test SaaS Deduplication Engine (Idempotency)
console.log('\n[TEST 6] Testing Ingestion Deduplication Engine...');
const store = new MultiTenantMetadataStore('test-region');
const dedupEngine = new IngestionDeduplicationEngine(store);
const pId = crypto.randomUUID();
const ingestPayload = {
  payload_id: pId,
  tenant_id: 'tenant-test',
  collector_id: 'col-01',
  timestamp_utc: new Date().toISOString(),
  metrics: { cpu_percent: 22.0 },
  severity: 'INFO'
};
const res1 = dedupEngine.processIncomingPayload(ingestPayload);
assert.strictEqual(res1.status, 'ACCEPTED', 'First attempt must be accepted');
const res2 = dedupEngine.processIncomingPayload(ingestPayload); // duplicate retry
assert.strictEqual(res2.status, 'DUPLICATE_DROPPED', 'Duplicate retry must be safely dropped');
assert.strictEqual(res2.isDuplicate, true, 'isDuplicate flag should be true');
console.log('✓ Idempotency verified: Re-transmission safely dropped without polluting database.');

// 7. Test Four-State Health Classification Engine
console.log('\n[TEST 7] Testing Four-State Health Classifier & Stale Watchdog...');
const healthEval = new FourStateHealthEvaluator(store);
const normalHealth = healthEval.evaluateIncomingTelemetry({
  tenant_id: 'tenant-test',
  collector_id: 'col-01',
  metrics: { cpu_percent: 25.0, memory_percent: 40.0, latency_ms: 20.0, packet_loss_percent: 0.0 }
});
assert.strictEqual(normalHealth.state, 'EXCELLENT', 'Normal telemetry must be EXCELLENT');

const poorHealth = healthEval.evaluateIncomingTelemetry({
  tenant_id: 'tenant-test',
  collector_id: 'col-01',
  metrics: { cpu_percent: 98.0, memory_percent: 94.0, latency_ms: 350.0, packet_loss_percent: 15.0 }
});
assert.strictEqual(poorHealth.state, 'POOR', 'Saturation must downgrade state to POOR');
console.log('✓ Four-State classification verified: EXCELLENT -> POOR on threshold breach.');

// 8. Test Explainable AIOps Correlation & Incident Grouping
console.log('\n[TEST 8] Testing Explainable AIOps Correlation & Incident Attribution...');
const aiops = new ExplainableAIOpsEngine(store);
const incident = aiops.analyze({
  tenant_id: 'tenant-test',
  event_category: 'CASCADE_SYSTEM_INCIDENT',
  severity: 'CRITICAL',
  metrics: { cpu_percent: 97.0, memory_percent: 94.0, latency_ms: 420.0, packet_loss_percent: 14.0 }
});
assert.ok(incident !== null, 'AIOps engine must create incident');
assert.ok(incident.explainability.confidence_percent >= 90, 'Confidence must be >= 90%');
assert.ok(incident.explainability.signal_attribution.latency > 0, 'Signal attribution must have latency');
assert.ok(incident.explainability.reasoning_path.length > 0, 'Reasoning path must be documented');
console.log(`✓ Explainable AIOps incident generated: ${incident.title} (Confidence: ${incident.explainability.confidence_percent}%)`);

// 9. Test Autonomous Ops Human-in-the-Loop & Rollback
console.log('\n[TEST 9] Testing Autonomous Ops Policy Check, Approval & Rollback...');
const autoOps = new AutonomousOpsManager(store);
const proposed = autoOps.proposeRemediation(incident);
assert.strictEqual(proposed.status, 'PENDING_APPROVAL', 'Initial status must be PENDING_APPROVAL');
assert.strictEqual(proposed.policy_verified, true, 'Policy verification must be true');

const executed = autoOps.approveAndExecute(proposed.action_id, 'Lead Operator');
assert.strictEqual(executed.status, 'EXECUTED', 'Status must transition to EXECUTED upon approval');

const rollback = autoOps.executeRollback(proposed.action_id, 'Lead Operator');
assert.strictEqual(rollback.status, 'ROLLED_BACK', 'Status must transition to ROLLED_BACK');
console.log('✓ Autonomous Ops verified: Policy Check -> Approval Gate -> Execution -> Rollback.');

console.log('\n================================================================');
console.log('   ALL 9 TEST SUITES PASSED WITH 100% SUCCESS RATE              ');
console.log('================================================================');
