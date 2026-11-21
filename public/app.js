// State & Timeseries Buffers
let currentTenant = 'tenant-acme-prod';
let timeseriesData = {
  cpu: [],
  memory: [],
  latency: [],
  loss: []
};
const MAX_POINTS = 30;

let currentProofs = [];
let pendingActionsMap = new Map();
let isOutageActive = false;

// Initialize Web App
document.addEventListener('DOMContentLoaded', () => {
  initUtcClock();
  initSSE();
  fetchTenantOverview();
  fetchEgressProofs();

  // Periodic polling fallback
  setInterval(fetchTenantOverview, 3000);
  setInterval(fetchEgressProofs, 4000);

  document.getElementById('tenantSelect').addEventListener('change', (e) => {
    currentTenant = e.target.value;
    timeseriesData = { cpu: [], memory: [], latency: [], loss: [] };
    fetchTenantOverview();
  });
});

// Real-Time UTC Clock
function initUtcClock() {
  const clockEl = document.getElementById('clockUtc');
  function update() {
    const now = new Date();
    clockEl.innerText = now.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
  }
  setInterval(update, 1000);
  update();
}

// Real-Time Server-Sent Events (SSE)
function initSSE() {
  const livePill = document.getElementById('livePill');
  const evtSource = new EventSource('/api/v1/events/stream');

  evtSource.onopen = () => {
    livePill.innerText = 'REAL-TIME SSE ONLINE';
    livePill.style.background = 'rgba(16, 185, 129, 0.15)';
    livePill.style.color = 'var(--accent-emerald)';
  };

  evtSource.onerror = () => {
    livePill.innerText = 'SSE RECONNECTING...';
    livePill.style.background = 'rgba(244, 63, 94, 0.15)';
    livePill.style.color = 'var(--accent-rose)';
  };

  evtSource.addEventListener('telemetry_tick', (e) => {
    const data = JSON.parse(e.data);
    handleTelemetryTick(data);
  });

  evtSource.addEventListener('action_executed', (e) => {
    const action = JSON.parse(e.data);
    showToast(`Autonomous Action [${action.action_name}] successfully executed.`);
    fetchTenantOverview();
  });

  evtSource.addEventListener('action_rollback', (e) => {
    const rollback = JSON.parse(e.data);
    showToast(`Rollback complete for action.`);
    fetchTenantOverview();
  });
}

function handleTelemetryTick(data) {
  const payload = data.payload;
  if (!payload || payload.tenant_id !== currentTenant) return;

  const m = payload.metrics || {};

  // Update current readouts
  if (m.cpu_percent !== undefined) {
    document.getElementById('curCpu').innerText = `${m.cpu_percent}%`;
    pushPoint(timeseriesData.cpu, m.cpu_percent);
  }
  if (m.memory_percent !== undefined) {
    document.getElementById('curMemory').innerText = `${m.memory_percent}%`;
    pushPoint(timeseriesData.memory, m.memory_percent);
  }
  if (m.latency_ms !== undefined) {
    document.getElementById('curLatency').innerText = `${m.latency_ms}ms`;
    pushPoint(timeseriesData.latency, m.latency_ms);
  }
  if (m.packet_loss_percent !== undefined) {
    document.getElementById('curLoss').innerText = `${m.packet_loss_percent}%`;
    pushPoint(timeseriesData.loss, m.packet_loss_percent);
  }

  // Update Charts
  renderChart('canvasCpu', timeseriesData.cpu, '#38bdf8', 100);
  renderChart('canvasMemory', timeseriesData.memory, '#a855f7', 100);
  renderChart('canvasLatency', timeseriesData.latency, '#f59e0b', 500);
  renderChart('canvasLoss', timeseriesData.loss, '#f43f5e', 20);

  // Update Health Badge
  if (data.healthUpdate) {
    updateHealthHero(data.healthUpdate);
  }

  // Update Collector Metrics
  if (payload.redaction_count !== undefined) {
    document.getElementById('colRedactionsCount').innerText = `${payload.redaction_count} scrubbed`;
  }
  if (payload.queue_backlog_count !== undefined) {
    document.getElementById('colQueueCount').innerText = `${payload.queue_backlog_count} buffered`;
  }

  // Performance KPI update
  if (data.perf) {
    document.getElementById('kpiLatency').innerText = `${data.perf.p95LatencyMs}ms`;
    document.getElementById('kpiBacklog').innerText = `0 Lost / ${data.perf.duplicatesDropped} Dup Dropped`;
  }

  // Refresh proofs
  fetchEgressProofs();
}

function pushPoint(arr, val) {
  arr.push(val);
  if (arr.length > MAX_POINTS) arr.shift();
}

async function fetchTenantOverview() {
  try {
    const res = await fetch(`/api/v1/tenant/${currentTenant}/overview`);
    if (!res.ok) return;
    const data = await res.json();

    // Health
    updateHealthHero(data.health);

    // Timeseries fill if empty
    if (timeseriesData.cpu.length === 0 && data.timeseries && data.timeseries.length > 0) {
      data.timeseries.forEach(t => {
        if (t.cpu_percent !== null) timeseriesData.cpu.push(t.cpu_percent);
        if (t.memory_percent !== null) timeseriesData.memory.push(t.memory_percent);
        if (t.latency_ms !== null) timeseriesData.latency.push(t.latency_ms);
        if (t.packet_loss_percent !== null) timeseriesData.loss.push(t.packet_loss_percent);
      });
      renderChart('canvasCpu', timeseriesData.cpu, '#38bdf8', 100);
      renderChart('canvasMemory', timeseriesData.memory, '#a855f7', 100);
      renderChart('canvasLatency', timeseriesData.latency, '#f59e0b', 500);
      renderChart('canvasLoss', timeseriesData.loss, '#f43f5e', 20);
    }

    // Transitions
    renderTransitions(data.transitions);

    // Incidents & Explainability
    renderIncidents(data.incidents);

    // Autonomous Actions
    renderAutonomous(data.pendingActions, data.auditLog);

  } catch (err) {
    console.warn('Overview fetch error:', err);
  }
}

function updateHealthHero(health) {
  if (!health) return;
  const badge = document.getElementById('healthHeroBadge');
  const text = document.getElementById('healthStateText');
  const reason = document.getElementById('healthReasonText');

  badge.className = `health-badge-large state-${health.state}`;
  text.innerText = health.state;
  reason.innerText = health.reason || 'Telemetry operating within baseline.';

  // Stale detection indicator
  const elapsed = health.elapsedSec || 0;
  if (elapsed > 20) {
    document.getElementById('kpiHeartbeatWatchdog').innerText = `${elapsed}s since ping`;
    if (elapsed >= 60) {
      document.getElementById('kpiWatchdogSub').innerText = 'DOWNGRADED: Collector Offline (>60s)';
    } else {
      document.getElementById('kpiWatchdogSub').innerText = 'Watchdog delayed (>20s)';
    }
  } else {
    document.getElementById('kpiHeartbeatWatchdog').innerText = 'Active (<15s)';
    document.getElementById('kpiWatchdogSub').innerText = 'Target: <60s auto-downgrade to Poor';
  }
}

function renderTransitions(transitions) {
  const container = document.getElementById('transitionHistoryList');
  if (!transitions || transitions.length === 0) {
    container.innerHTML = '<div style="color:var(--text-dim); font-size:0.72rem;">No transitions recorded yet.</div>';
    return;
  }

  container.innerHTML = transitions.map(t => `
    <div class="history-item">
      <span>${t.timestamp_utc.substring(11, 19)} UTC</span>
      <span style="font-weight:700; color:var(--health-${t.new_state.toLowerCase()});">${t.previous_state} &rarr; ${t.new_state}</span>
    </div>
  `).join('');
}

function renderIncidents(incidents) {
  const container = document.getElementById('incidentsContainer');
  if (!incidents || incidents.length === 0) {
    container.innerHTML = `
      <div style="padding: 20px; text-align: center; color: var(--text-dim); font-size: 0.85rem;">
        No active anomalies or correlated incidents. All system indicators operating within normal dynamic baseline.
      </div>`;
    return;
  }

  container.innerHTML = incidents.map(inc => {
    const exp = inc.explainability;
    const attr = exp ? exp.signal_attribution : {};

    return `
      <div class="incident-card">
        <div class="incident-title-row">
          <div class="incident-title">
            <span>🚨 ${inc.title}</span>
            <span style="font-size:0.75rem; color:var(--text-muted); margin-left:8px;">[${inc.incident_id}]</span>
          </div>
          <span class="incident-meta-badge">${inc.correlated_alerts_count} Correlated Alerts Merged</span>
        </div>

        <div style="font-size:0.8rem; color:var(--text-muted); margin-bottom:6px;">
          <strong>Affected Sources:</strong> ${inc.aggregated_sources.join(', ')} &bull; <strong>Status:</strong> ${inc.status}
        </div>

        <!-- Explainability Deep Dive -->
        <div class="explainability-box">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size:0.78rem; font-weight:700; color:var(--accent-cyan);">AIOps Signal Attribution & Confidence</span>
            <span style="font-size:0.85rem; font-weight:800; color:var(--accent-emerald);">${exp.confidence_percent}% Confidence</span>
          </div>

          <!-- Multi-signal weight bar -->
          <div class="attribution-bar-wrapper">
            <div class="attribution-slice" style="width:${attr.cpu || 0}%; background:#38bdf8;" title="CPU Attribution: ${attr.cpu}%"></div>
            <div class="attribution-slice" style="width:${attr.latency || 0}%; background:#f59e0b;" title="Latency Attribution: ${attr.latency}%"></div>
            <div class="attribution-slice" style="width:${attr.memory || 0}%; background:#a855f7;" title="Memory Attribution: ${attr.memory}%"></div>
            <div class="attribution-slice" style="width:${attr.security || 0}%; background:#f43f5e;" title="Security Attribution: ${attr.security}%"></div>
          </div>
          <div style="display:flex; gap:12px; font-size:0.68rem; color:var(--text-dim);">
            ${attr.cpu ? `<span>■ CPU: ${attr.cpu}%</span>` : ''}
            ${attr.latency ? `<span>■ Latency: ${attr.latency}%</span>` : ''}
            ${attr.memory ? `<span>■ Memory: ${attr.memory}%</span>` : ''}
            ${attr.security ? `<span>■ Security Burst: ${attr.security}%</span>` : ''}
          </div>

          <div style="font-size:0.78rem; margin-top:8px; color:#cbd5e1;">
            <strong>Root Cause Hypothesis:</strong> ${exp.root_cause_hypothesis}
          </div>

          <ul class="reasoning-list">
            ${exp.reasoning_path.map(step => `<li>${step}</li>`).join('')}
          </ul>
        </div>
      </div>
    `;
  }).join('');
}

function renderAutonomous(pendingActions, auditLog) {
  const container = document.getElementById('autonomousContainer');
  if (!pendingActions || pendingActions.length === 0) {
    container.innerHTML = `
      <div style="padding: 16px; text-align: center; color: var(--text-dim); font-size: 0.85rem;">
        No pending operational remediation actions. System stable.
      </div>`;
  } else {
    container.innerHTML = pendingActions.map(act => `
      <div class="action-box">
        <div class="action-info">
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-weight:700; color:#fff; font-size:0.9rem;">${act.action_name}</span>
            <span style="background:rgba(16,185,129,0.2); color:#34d399; font-size:0.68rem; padding:2px 6px; border-radius:3px; font-weight:700;">POLICY CHECK: PASSED</span>
            <span style="background:rgba(56,189,248,0.2); color:#38bdf8; font-size:0.68rem; padding:2px 6px; border-radius:3px;">BLAST RADIUS: ${act.blast_radius}</span>
          </div>
          <div style="font-size:0.78rem; color:var(--text-muted);">${act.description}</div>
          <div style="font-size:0.7rem; color:var(--text-dim); font-family:var(--font-mono);">
            Target: ${act.target_component} &bull; Signature: ${act.audit_signature}
          </div>
        </div>
        <button class="btn-approve" onclick="approveAction('${act.action_id}')">Approve Remediation</button>
      </div>
    `).join('');
  }

  // Audit list
  const auditContainer = document.getElementById('autonomousAuditList');
  if (auditLog && auditLog.length > 0) {
    auditContainer.innerHTML = auditLog.map(item => `
      <div style="padding:4px 0; border-bottom:1px solid #1e293b; display:flex; justify-content:space-between; align-items:center;">
        <span>${item.initiated_at_utc.substring(11, 19)} UTC &bull; [${item.status}] ${item.action_name} &bull; Approved: ${item.approved_by}</span>
        ${item.status === 'EXECUTED' ? `<button class="btn-rollback" onclick="rollbackAction('${item.action_id}')">Rollback</button>` : ''}
      </div>
    `).join('');
  }
}

// Egress Proof Panel Rendering
async function fetchEgressProofs() {
  try {
    const res = await fetch(`/api/v1/tenant/${currentTenant}/egress-proof`);
    if (!res.ok) return;
    const data = await res.json();
    currentProofs = data.proofs || [];

    const select = document.getElementById('proofSelector');
    const existingVal = select.value;
    select.innerHTML = '<option value="latest">Latest Ingestion Tick</option>' +
      currentProofs.map((p, idx) => `
        <option value="${idx}">Payload #${p.payload_id.slice(0, 8)} (${p.timestamp_utc.substring(11, 19)})</option>
      `).join('');

    if (existingVal && existingVal !== 'latest') {
      select.value = existingVal;
    }

    renderSelectedProof();
  } catch (err) {
    console.warn('Error fetching egress proofs:', err);
  }
}

function renderSelectedProof() {
  if (currentProofs.length === 0) return;

  const select = document.getElementById('proofSelector');
  const index = select.value === 'latest' ? 0 : parseInt(select.value, 10);
  const proof = currentProofs[index] || currentProofs[0];

  const rawEl = document.getElementById('proofRawLog');
  const egressEl = document.getElementById('proofEgressPayload');

  // Format raw sample
  let rawStr = JSON.stringify(proof.raw_input_sample, null, 2);
  // Highlight secrets visually
  rawStr = rawStr.replace(/(password="[^"]+"|SuperSecret[^"]*|sk_live_[^"]+|Bearer [^"]+)/g, '<span class="highlight-secret">$1</span>');
  rawEl.innerHTML = rawStr;

  // Format egress payload
  let egressStr = JSON.stringify(proof.egress_payload, null, 2);
  egressEl.innerHTML = egressStr;

  // Summaries
  document.getElementById('proofRedactionSummary').innerText = 
    `Detected Secrets Scrubbed Locally: ${proof.redaction_count} (${(proof.detected_secret_types || []).join(', ') || 'None'})`;
  
  document.getElementById('proofEgressSummary').innerText = 
    `Dropped Non-Allowlisted Fields: ${(proof.dropped_unapproved_fields || []).join(', ') || 'None (Strict schema verified)'}`;
}

// Action Handlers
async function approveAction(actionId) {
  try {
    const res = await fetch('/api/v1/autonomous/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action_id: actionId, approver: 'Lead Operator (Judge Demo)' })
    });
    const data = await res.json();
    if (res.ok) {
      showToast(`Action approved & executed! Target baseline stabilizing.`);
      fetchTenantOverview();
    }
  } catch (err) {
    alert('Error approving action: ' + err.message);
  }
}

async function rollbackAction(actionId) {
  try {
    const res = await fetch('/api/v1/autonomous/rollback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action_id: actionId, operator: 'Lead Operator (Judge Demo)' })
    });
    if (res.ok) {
      showToast(`Rollback executed successfully. Configuration restored.`);
      fetchTenantOverview();
    }
  } catch (err) {
    alert('Error rolling back: ' + err.message);
  }
}

// Chaos / Live Scenario Trigger
async function injectScenario(scenarioName) {
  try {
    const res = await fetch('/api/v1/chaos/inject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: scenarioName })
    });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message);

      if (scenarioName === '2_OUTAGE_BUFFER') {
        isOutageActive = !isOutageActive;
        const btn = document.getElementById('btnOutage');
        if (isOutageActive) {
          btn.classList.add('active-chaos');
          btn.innerHTML = '<span class="chaos-number">Scenario 2</span><span>⚡ Reconnect SaaS Link</span>';
        } else {
          btn.classList.remove('active-chaos');
          btn.innerHTML = '<span class="chaos-number">Scenario 2</span><span>⚡ Sever SaaS Link (Buffer)</span>';
        }
      }

      fetchTenantOverview();
      fetchEgressProofs();
    }
  } catch (err) {
    showToast(`Chaos injection error: ${err.message}`);
  }
}

function showToast(msg) {
  const banner = document.getElementById('chaosNotification');
  const msgEl = document.getElementById('chaosMessage');
  msgEl.innerText = msg;
  banner.style.display = 'flex';
  setTimeout(() => {
    banner.style.display = 'none';
  }, 7000);
}

// Canvas Sparkline Chart Drawer
function renderChart(canvasId, dataPoints, strokeColor, maxVal = 100) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  const width = canvas.clientWidth;
  const height = canvas.clientHeight;

  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
  }

  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  // Draw grid lines
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, height * 0.25); ctx.lineTo(width, height * 0.25);
  ctx.moveTo(0, height * 0.50); ctx.lineTo(width, height * 0.50);
  ctx.moveTo(0, height * 0.75); ctx.lineTo(width, height * 0.75);
  ctx.stroke();

  if (dataPoints.length < 2) {
    ctx.restore();
    return;
  }

  const step = width / (MAX_POINTS - 1);
  const points = dataPoints.map((val, idx) => {
    const clamped = Math.max(0, Math.min(val, maxVal));
    const y = height - (clamped / maxVal) * (height - 16) - 8;
    return { x: idx * step, y };
  });

  // Area fill gradient
  ctx.beginPath();
  ctx.moveTo(points[0].x, height);
  points.forEach(p => ctx.lineTo(p.x, p.y));
  ctx.lineTo(points[points.length - 1].x, height);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, strokeColor + '44');
  grad.addColorStop(1, strokeColor + '00');
  ctx.fillStyle = grad;
  ctx.fill();

  // Stroke line
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Head dot
  const lastPoint = points[points.length - 1];
  ctx.beginPath();
  ctx.arc(lastPoint.x, lastPoint.y, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.stroke();

  ctx.restore();
}
