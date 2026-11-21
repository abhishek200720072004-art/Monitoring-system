import crypto from 'node:crypto';

export class TelemetryGenerator {
  constructor() {
    this.chaosState = {
      latencySpike: false,
      cpuAnomaly: false,
      memoryLeak: false,
      multiAlertStorm: false,
      secretLogInjected: false,
      activeSecretLog: null,
      authBurstActive: false
    };

    this.simulatedMemoryPercent = 44.0;
  }

  setChaos(type, active = true, extra = null) {
    if (type === 'latencySpike') this.chaosState.latencySpike = active;
    if (type === 'cpuAnomaly') this.chaosState.cpuAnomaly = active;
    if (type === 'memoryLeak') this.chaosState.memoryLeak = active;
    if (type === 'multiAlertStorm') this.chaosState.multiAlertStorm = active;
    if (type === 'secretLog') {
      this.chaosState.secretLogInjected = active;
      this.chaosState.activeSecretLog = extra;
    }
    if (type === 'authBurst') this.chaosState.authBurstActive = active;
    if (type === 'reset') {
      this.chaosState = {
        latencySpike: false,
        cpuAnomaly: false,
        memoryLeak: false,
        multiAlertStorm: false,
        secretLogInjected: false,
        activeSecretLog: null,
        authBurstActive: false
      };
      this.simulatedMemoryPercent = 44.0;
    }
  }

  generateRawTick(hostname = 'prod-k8s-node-04.internal.corp') {
    // Random baseline jitter
    let cpu = 22 + (Math.random() * 8);
    let disk = 14 + (Math.random() * 6);
    let latency = 16 + (Math.random() * 10);
    let packetLoss = Math.random() < 0.95 ? 0.0 : (Math.random() * 0.4);
    let bandwidth = 135 + (Math.random() * 20);
    let errorRate = 0.02 + (Math.random() * 0.03);

    if (this.chaosState.memoryLeak) {
      this.simulatedMemoryPercent = Math.min(98.5, this.simulatedMemoryPercent + 2.5);
    } else if (!this.chaosState.cpuAnomaly) {
      this.simulatedMemoryPercent = 44 + (Math.random() * 4);
    }

    let memory = this.simulatedMemoryPercent;

    // Apply chaos modifications
    let rawLogSample = null;
    let eventCategory = 'METRIC_TICK';
    let severity = 'INFO';
    let alertContext = 'normal_baseline';

    if (this.chaosState.secretLogInjected) {
      rawLogSample = this.chaosState.activeSecretLog || 
        `[FATAL] DB_CONNECT_FAIL host="${hostname}" user="admin" password="SuperSecretPassword#991" api_key="sk_live_99f82bc719dae4c" token="Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-ID198"`;
      this.chaosState.secretLogInjected = false; // consume one-shot
      eventCategory = 'SECURITY_AUDIT_LOG';
      severity = 'CRITICAL';
      alertContext = 'db_connection_credentials_exposed';
    }

    if (this.chaosState.latencySpike) {
      latency = 380 + (Math.random() * 80);
      packetLoss = 12.5 + (Math.random() * 6.0);
      eventCategory = 'NETWORK_DEGRADATION';
      severity = 'CRITICAL';
      alertContext = 'network_packet_loss_and_latency_spike';
    }

    if (this.chaosState.cpuAnomaly) {
      cpu = 95.5 + (Math.random() * 4.0);
      memory = 92.0 + (Math.random() * 5.0);
      eventCategory = 'RESOURCE_SATURATION';
      severity = 'CRITICAL';
      alertContext = 'cpu_and_memory_baseline_deviation';
    }

    if (this.chaosState.multiAlertStorm) {
      cpu = 97.2;
      memory = 94.8;
      latency = 420.0;
      packetLoss = 14.2;
      errorRate = 8.6;
      eventCategory = 'CASCADE_SYSTEM_INCIDENT';
      severity = 'CRITICAL';
      alertContext = 'cascading_database_and_gateway_failure';
      rawLogSample = `[ERROR] HTTP 504 Gateway Timeout from backend pool db-master: Query duration 12400ms > timeout. Host="${hostname}".`;
    }

    return {
      rawHostname: hostname,
      rawLogSample: rawLogSample || `[INFO] Health check passed on ${hostname} at ${new Date().toISOString()}`,
      metrics: {
        cpu_percent: Math.round(cpu * 10) / 10,
        memory_percent: Math.round(memory * 10) / 10,
        disk_io_percent: Math.round(disk * 10) / 10,
        latency_ms: Math.round(latency * 10) / 10,
        packet_loss_percent: Math.round(packetLoss * 100) / 100,
        bandwidth_mbps: Math.round(bandwidth * 10) / 10,
        error_rate_percent: Math.round(errorRate * 100) / 100
      },
      eventCategory,
      severity,
      alertContext
    };
  }
}
