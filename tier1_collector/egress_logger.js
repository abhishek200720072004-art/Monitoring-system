import fs from 'node:fs';
import path from 'node:path';

export class EgressProofLogger {
  constructor() {
    this.auditFile = path.join(process.cwd(), 'tier1_collector', 'data', 'egress_proof_audit.json');
    this.recentProofEntries = [];
    this.maxMemoryEntries = 50;

    const dir = path.dirname(this.auditFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  logProof({
    payloadId,
    rawInputSample,
    egressPayload,
    redactionCount,
    detectedSecretTypes,
    droppedKeys
  }) {
    const entry = {
      id: `proof-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      payload_id: payloadId,
      timestamp_utc: new Date().toISOString(),
      raw_input_sample: rawInputSample,
      egress_payload: egressPayload,
      redaction_count: redactionCount || 0,
      detected_secret_types: detectedSecretTypes || [],
      dropped_unapproved_fields: droppedKeys || []
    };

    this.recentProofEntries.unshift(entry);
    if (this.recentProofEntries.length > this.maxMemoryEntries) {
      this.recentProofEntries.pop();
    }

    try {
      fs.writeFileSync(this.auditFile, JSON.stringify(this.recentProofEntries, null, 2));
    } catch {
      // non-blocking
    }

    return entry;
  }

  getRecentProofs(limit = 15) {
    return this.recentProofEntries.slice(0, limit);
  }
}
