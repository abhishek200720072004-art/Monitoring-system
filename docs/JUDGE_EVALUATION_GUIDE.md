# Judge's Evaluation Walkthrough & Live Demo Guide
**CICADA 2026 Hackathon | 24-Hour Hackathon Evaluation**

---

## 1. Quick Start Commands

```bash
# Start the unified Two-Tier Platform (Tier 1 Collector + Tier 2 SaaS + Web UI)
npm start
# Or using Node directly:
node index.js
```
Open **`http://localhost:3000`** in your browser.

---

## 2. Walkthrough of the 4 Evaluation Phases (100 Marks)

### Phase 1: Problem Understanding & Ideation (10 Marks)
* **Trust Boundary Defense:** Show the architecture diagram in `docs/ARCHITECTURE.md`. Explain why streaming raw logs to a central cloud is an existential security threat and regulatory violation.
* **Allow-List Specification:** Open `docs/ALLOW_LIST_SPEC.md` to demonstrate the deny-by-default schema policy.

### Phase 2: Architecture & Technical Design (25 Marks)
* **Two-Tier Separation:** Demonstrate the separate directories `tier1_collector/` (runs inside customer network) and `tier2_saas/` (runs in regional SaaS cloud).
* **Security Controls:** Show the secret scrubber in `tier1_collector/scrubber.js` (Regex + Shannon Entropy) and the SQLite WAL persistent queue in `tier1_collector/local_buffer.js`.
* **Global-Ready Design:** Highlight the UTC timestamps, source timezone awareness (`Asia/Kolkata`), regional ingest endpoint routing (`ap-south-1`), and out-of-order event-time sorting.

### Phase 3: Implementation & Working Prototype (35 Marks)
* **Egress Proof Panel (Mandatory):** Scroll to the Egress Proof Panel on the dashboard. Show the raw customer log side-by-side with the egress metadata.
* **Four Health States:** Point to the large health badge classifying system health into `EXCELLENT`, `GOOD`, `FAIR`, or `POOR` with clear thresholds and transition history.
* **Outage Resilience (10 of 35 Marks):** Click **Scenario 2 (Sever SaaS Link)**. Watch the collector queue buffered records in SQLite without losing a single item. Click again to reconnect, and verify zero records lost and zero duplicates delivered!

### Phase 4: Final Demo, Validation & Presentation (30 Marks)
Execute the 8 live judge validation scenarios directly from the top toolbar:

| Scenario | Click Button | What to Highlight to Judges |
|---|---|---|
| **1. Raw Log Secret** | `Scenario 1` | Scroll to Egress Proof Panel: see raw password/token highlighted in red on local host, while the SaaS egress payload on the right contains **zero secrets**. |
| **2. SaaS Outage** | `Scenario 2` | Watch "Collector Buffer Queue" accumulate items in SQLite. Click button again to reconnect; see instant backlog replay with **0 lost and 0 duplicates**. |
| **3. Failed Logins** | `Scenario 3` | Local security engine catches brute-force attack; health degrades to `POOR`, creating a risk summary indicator **without exposing raw user passwords or IPs**. |
| **4. Network Latency** | `Scenario 4` | Latency chart jumps to >400ms, packet loss >12%; health degrades to `POOR`. |
| **5. CPU Deviation** | `Scenario 5` | CPU jumps to 98% (>3.5σ above baseline); AIOps anomaly detector triggers with root cause explanation. |
| **6. Multi-Alert Storm** | `Scenario 6` | High CPU + DB Latency + 504 Timeout triggered simultaneously; AIOps engine merges all alerts into **1 Parent Correlated Incident**, eliminating alert fatigue. |
| **7. Duplicate Payload** | `Scenario 7` | Injects an identical payload ID; SaaS Deduplication Engine flags `DUPLICATE_DROPPED`, preventing duplicate trend pollution. |
| **8. Autonomous Ops** | `Scenario 8` | Pending safe remediation card appears. Click **"Approve Remediation"**; system verifies policy bounds, executes simulated fix, stabilizes metrics, and offers **1-Click Rollback**. |
| **Reset Baseline** | `Reset` | Restores all operational metrics back to normal healthy baselines. |
