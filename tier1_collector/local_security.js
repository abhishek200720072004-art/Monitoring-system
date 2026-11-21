import fs from 'node:fs';
import path from 'node:path';
import { pseudonymizeUser } from './scrubber.js';

export class LocalSecurityDetector {
  constructor() {
    this.failedAttempts = [];
    this.thresholdCount = 5;       // 5 failed logins within window triggers warning
    this.windowSeconds = 30;      // 30s evaluation window
    this.logFile = path.join(process.cwd(), 'tier1_collector', 'data', 'local_raw_security.log');

    // Ensure raw security log file exists for local inspection
    const dir = path.dirname(this.logFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  /**
   * Records a raw authentication event.
   * This raw record stays 100% inside customer premises!
   */
  recordAuthEvent({ username, ip, success, reason, timestamp = Date.now() }) {
    // Append to local-only audit file (with full raw details)
    const logEntry = `[${new Date(timestamp).toISOString()}] [RAW_LOCAL_AUTH] user="${username}" ip="${ip}" success=${success} reason="${reason || 'none'}"\n`;
    try {
      fs.appendFileSync(this.logFile, logEntry);
    } catch (e) {
      // non-blocking
    }

    if (!success) {
      this.failedAttempts.push({ username, ip, timestamp });
    }

    return this.evaluateSecuritySignals();
  }

  /**
   * Evaluates if brute-force attack or credential stuffing is underway.
   * Produces a sanitized, allow-listed metadata summary.
   */
  evaluateSecuritySignals() {
    const now = Date.now();
    const cutoff = now - (this.windowSeconds * 1000);

    // Prune old events outside sliding window
    this.failedAttempts = this.failedAttempts.filter(e => e.timestamp >= cutoff);

    const count = this.failedAttempts.length;
    if (count >= this.thresholdCount) {
      // Calculate risk score (0 to 100)
      const riskScore = Math.min(100, Math.round(count * 8.5));
      const mostFrequentUser = this.getMostFrequentTarget();

      return {
        isAlert: true,
        summary: {
          failed_attempts: count,
          window_sec: this.windowSeconds,
          risk_score: riskScore
        },
        alertContext: 'repeated_auth_failures_detected',
        severity: count >= 10 ? 'CRITICAL' : 'WARNING',
        pseudonymTarget: pseudonymizeUser(mostFrequentUser)
      };
    }

    return {
      isAlert: false,
      summary: {
        failed_attempts: count,
        window_sec: this.windowSeconds,
        risk_score: 0
      }
    };
  }

  getMostFrequentTarget() {
    if (this.failedAttempts.length === 0) return 'unknown';
    const counts = {};
    for (const e of this.failedAttempts) {
      counts[e.username] = (counts[e.username] || 0) + 1;
    }
    let topUser = 'unknown';
    let max = 0;
    for (const [u, c] of Object.entries(counts)) {
      if (c > max) {
        max = c;
        topUser = u;
      }
    }
    return topUser;
  }

  getRecentRawLogs(limit = 10) {
    if (!fs.existsSync(this.logFile)) return [];
    try {
      const content = fs.readFileSync(this.logFile, 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);
      return lines.slice(-limit);
    } catch {
      return [];
    }
  }
}
