export class IngestionDeduplicationEngine {
  constructor(storage) {
    this.storage = storage;
    this.duplicateCounter = 0;
    this.totalIngested = 0;
    this.latencyHistory = [];
  }

  processIncomingPayload(payload) {
    const arrivalTime = new Date();
    const eventTime = new Date(payload.timestamp_utc || arrivalTime);

    // Calculate collection-to-ingest latency (in milliseconds)
    const latencyMs = Math.max(0, arrivalTime.getTime() - eventTime.getTime());
    this.latencyHistory.push(latencyMs);
    if (this.latencyHistory.length > 100) this.latencyHistory.shift();

    // 1. Idempotency Check: Payload ID deduplication
    if (this.storage.isDuplicate(payload.payload_id)) {
      this.duplicateCounter++;
      return {
        status: 'DUPLICATE_DROPPED',
        payload_id: payload.payload_id,
        message: 'Payload previously ingested. Duplicate safely dropped without re-processing.',
        isDuplicate: true,
        latencyMs
      };
    }

    // 2. Record payload into tenant-isolated storage (ordered by event_timestamp_utc)
    this.storage.recordPayload(payload, arrivalTime.toISOString());
    this.totalIngested++;

    return {
      status: 'ACCEPTED',
      payload_id: payload.payload_id,
      isDuplicate: false,
      latencyMs
    };
  }

  getMetrics() {
    const sorted = [...this.latencyHistory].sort((a, b) => a - b);
    const p95Index = Math.floor(sorted.length * 0.95);
    const p95Latency = sorted.length > 0 ? sorted[p95Index] : 0;

    return {
      totalIngested: this.totalIngested,
      duplicatesDropped: this.duplicateCounter,
      p95LatencyMs: Math.round(p95Latency),
      sampleCount: this.latencyHistory.length
    };
  }
}
