# Data Protection & Metadata Allow-List Specification

**CICADA 2026 Hackathon | Evaluation Evidence**

---

## 1. What Stays Local (Never Transmitted to SaaS)
The following data categories are **strictly prohibited** from leaving Tier 1:
* Raw log messages and full-text syslog lines.
* Database query strings and SQL statements.
* Plaintext credentials, passwords, auth tokens, JWTs, and API keys.
* Customer PII (Email addresses, phone numbers, credit card numbers).
* Real internal hostname topology (e.g. `prod-db-master-01.internal.corp`).
* Real internal private IP addresses (e.g. `10.x.x.x`, `192.168.x.x`).
* Core dumps, raw exception stack traces, and memory heap snapshots.

---

## 2. Permitted Egress Metadata Schema (Strict Allow-List)

Any payload leaving Tier 1 must strictly conform to this JSON schema. Non-whitelisted keys are automatically dropped:

```json
{
  "payload_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "tenant_id": "tenant-acme-prod",
  "collector_id": "col-eu-01",
  "collector_version": "v2.4.0-cicada",
  "timestamp_utc": "2026-11-20T14:45:10.124Z",
  "source_tz": "Asia/Kolkata",
  "source_type": "INFRASTRUCTURE",
  "pseudonym_source_id": "node-8b7a4c",
  "metrics": {
    "cpu_percent": 24.5,
    "memory_percent": 44.2,
    "disk_io_percent": 15.0,
    "latency_ms": 18.2,
    "packet_loss_percent": 0.0,
    "bandwidth_mbps": 138.5,
    "error_rate_percent": 0.02
  },
  "health_indicator": "EXCELLENT",
  "event_category": "METRIC_TICK",
  "severity": "INFO",
  "alert_context": "normal_baseline",
  "security_summary": {
    "failed_attempts": 0,
    "window_sec": 30,
    "risk_score": 0
  },
  "redaction_count": 0,
  "queue_backlog_count": 0
}
```

---

## 3. Scrubbing & Redaction Rules

| Vulnerability Type | Detection Mechanism | Action Applied | Replacement Token |
|---|---|---|---|
| **API Keys & Tokens** | Regex (`api_key=`, `token=`, `Bearer `) | Redact token value | `[REDACTED_API_KEY]` |
| **Passwords & Credentials** | Regex (`password=`, `pwd=`, `secret=`) | Redact credential | `[REDACTED_PASSWORD]` |
| **High Entropy Secrets** | Shannon entropy $> 4.35$ on length $\ge 18$ | Redact secret string | `[REDACTED_HIGH_ENTROPY_TOKEN]` |
| **Private IPs** | CIDR boundary matching | Drop or pseudonymize | Redacted locally |
| **Internal Hostnames** | Salted SHA-256 hash | Deterministic mapping | `node-[hash:8]` |
| **Internal Usernames** | Salted SHA-256 hash | Deterministic mapping | `usr-[hash:8]` |
