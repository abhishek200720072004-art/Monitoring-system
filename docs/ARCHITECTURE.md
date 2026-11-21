# System Architecture: Secure Two-Tier AIOps Observability Platform
**CICADA 2026 Hackathon | TechForcz &times; Atria Institute of Technology**

---

## 1. Architectural Philosophy: Local-First, Metadata-Only

Traditional enterprise monitoring violates security and compliance boundaries by streaming unredacted operational data (syslog, DB traces, auth logs, packet captures) to multi-tenant public SaaS environments. 

This platform implements an uncompromising **Two-Tier Architecture**:
* **Tier 1 (Customer Environment / Local Collector):** All raw telemetry, unredacted syslog, credential payloads, and internal topologies are ingested, analyzed, and retained **strictly inside customer premises**.
* **Tier 2 (Central SaaS Platform):** Receives **allow-listed metadata only** (floating-point metrics, state enums, pseudonymous identifiers, and compact risk summaries).

```
+-----------------------------------------------------------------------------------------+
|                                TIER 1: CUSTOMER BOUNDARY                                |
|                                                                                         |
|  +--------------------+       +--------------------+       +-------------------------+  |
|  | Applications / DB  |       | Syslog / Auth Logs |       | Network / OS Metrics    |  |
|  +---------+----------+       +---------+----------+       +------------+------------+  |
|            |                            |                               |               |
|            v                            v                               v               |
|  +-----------------------------------------------------------------------------------+  |
|  |                       TIER 1 LOCAL COLLECTOR DAEMON                               |  |
|  |                                                                                   |  |
|  |  [Secret Scrubber]       --> Regex + Shannon Entropy (Stripping keys/passwords)   |  |
|  |  [Pseudonymizer]         --> Deterministic SHA-256 Salted Node / User Hashes      |  |
|  |  [Local Risk Detector]   --> Brute-force auth detection inside host               |  |
|  |  [Allow-List Filter]     --> Deny-by-default schema enforcement                   |  |
|  |  [Egress Proof Logger]   --> Generates verifiable raw vs. sanitized audit log     |  |
|  |  [Local SQLite Buffer]   --> WAL-mode persistent queue (Outage resilience)        |  |
|  +------------------------------------------+----------------------------------------+  |
+---------------------------------------------|-------------------------------------------+
                                              | Encrypted Ingest (TLS 1.3 / Bearer Token)
                                              | Metadata-Only Payload
                                              v
+-----------------------------------------------------------------------------------------+
|                                TIER 2: CENTRAL SAAS PLATFORM                            |
|                                                                                         |
|  +-----------------------------------------------------------------------------------+  |
|  |                         REGIONAL INGESTION GATEWAY                                |  |
|  |       (ap-south-1, us-east-1, eu-west-1 &bull; Tenant Isolation & Rate Limiting)      |  |
|  +------------------------------------------+----------------------------------------+  |
|                                             |                                           |
|                                             v                                           |
|  +-----------------------------------------------------------------------------------+  |
|  |                         CORE AIOPS & ANALYTICS ENGINE                             |  |
|  |                                                                                   |  |
|  |  [Deduplication & Out-of-Order] --> Event-time ordering via unique payload UUIDs |  |
|  |  [Four-State Health Evaluator]  --> EXCELLENT / GOOD / FAIR / POOR + Watchdog     |  |
|  |  [Dynamic Baseline Tracker]     --> Exponential Moving Average + Z-score anomaly  |  |
|  |  [Incident Correlation Engine]  --> Multi-signal clustering & noise reduction     |  |
|  |  [Explainable AI Engine]        --> Signal attribution, hypothesis, confidence    |  |
|  |  [Autonomous Ops Safeguards]    --> Human-approved remediation & 1-click rollback |  |
|  +------------------------------------------+----------------------------------------+  |
|                                             |                                           |
|                                             v                                           |
|  +-----------------------------------------------------------------------------------+  |
|  |                         MULTI-TENANT STORAGE & DASHBOARD                          |  |
|  |           Isolated Tenant DBs &bull; Real-time Server-Sent Events (SSE)           |  |
|  +-----------------------------------------------------------------------------------+  |
+-----------------------------------------------------------------------------------------+
```

---

## 2. Key Technical Innovations

### A. The Egress Proof Panel
To earn maximum marks during Phase 3 and Phase 4, the platform includes a live, verifiable **Egress Proof Panel**:
- Inspects any transmission tick side-by-side.
- Left side shows the raw customer telemetry (containing injected database connection passwords and tokens).
- Right side shows the exact JSON metadata payload dispatched over the network boundary, verifying zero leakage.

### B. Outage Buffering with Zero Loss & Zero Duplication
- Built on Node's native transactional SQLite (`DatabaseSync`) with Write-Ahead Logging (`WAL`).
- If SaaS or network becomes unreachable, all approved metadata records are queued on disk.
- When reconnected, payloads are delivered idempotently. The SaaS engine tracks processed UUIDs, ensuring **0 lost records and 0 duplicated trends**.

### C. Explainable AIOps (Beyond Static Thresholds)
- Traditional monitors fire noisy duplicate alerts when static thresholds breach.
- Our AIOps engine:
  1. Computes dynamic rolling statistical baselines ($\mu \pm 2.5\sigma$).
  2. Correlates multi-signal incidents (e.g., High CPU + Latency Spike + 504 Gateway Timeout) into **1 single parent Incident**.
  3. Provides **Signal Attribution** percentages (e.g., Latency 52%, CPU 36%, Packet Loss 12%).
  4. Formulates a human-readable **Root Cause Hypothesis** and a verifiable reasoning path.

### D. Safe Autonomous Ops (Roadmap Stage 5: Act)
- Unbounded autonomous action in production can be disastrous.
- Our platform enforces:
  1. **Policy Bounds Check:** Action must be in the approved safe catalog (`SCALE_WORKER`, `RECYCLE_POOL`).
  2. **Blast Radius Limiter:** Restricts impact to a single service group.
  3. **Human-in-the-Loop Approval:** Pending actions require lead operator review.
  4. **Cryptographic Audit Signature & Instant 1-Click Rollback:** Guaranteed reversible operations.
