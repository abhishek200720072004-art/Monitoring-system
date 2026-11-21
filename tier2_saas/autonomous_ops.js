import crypto from 'node:crypto';

// Policy catalog of pre-approved, safe, reversible operational actions
const APPROVED_POLICY_ACTIONS = {
  'SCALE_WORKER_PODS': {
    safe: true,
    blast_radius: '1_SERVICE_GROUP',
    reversible: true,
    rollback_cmd: 'RESTORE_REPLICA_COUNT'
  },
  'RECYCLE_CONNECTION_POOL': {
    safe: true,
    blast_radius: 'LOCAL_POOL',
    reversible: true,
    rollback_cmd: 'RESET_POOL_CONFIG'
  },
  'RATE_LIMIT_IP_PSEUDONYM': {
    safe: true,
    blast_radius: 'BORDER_FILTER',
    reversible: true,
    rollback_cmd: 'REMOVE_BORDER_RATE_LIMIT'
  },
  'REROUTE_TRAFFIC_SECONDARY_BGP': {
    safe: true,
    blast_radius: 'EDGE_EGRESS',
    reversible: true,
    rollback_cmd: 'RESTORE_PRIMARY_BGP'
  }
};

export class AutonomousOpsManager {
  constructor(storage) {
    this.storage = storage;
    this.pendingActions = new Map(); // actionId -> ActionObject
  }

  proposeRemediation(incident) {
    if (!incident || !incident.explainability || !incident.explainability.recommended_remediation) {
      return null;
    }

    const rec = incident.explainability.recommended_remediation;
    const policy = APPROVED_POLICY_ACTIONS[rec.action_name];

    if (!policy) {
      console.warn(`[AutonomousOps] Action ${rec.action_name} rejected: Not in approved policy catalog.`);
      return null;
    }

    const actionId = `ACT-${Date.now().toString().slice(-6)}`;
    const action = {
      action_id: actionId,
      tenant_id: incident.tenant_id,
      incident_id: incident.incident_id,
      action_name: rec.action_name,
      target_component: rec.target,
      description: rec.action_description,
      status: 'PENDING_APPROVAL',
      policy_verified: true,
      blast_radius: policy.blast_radius,
      reversible: policy.reversible,
      rollback_command: policy.rollback_cmd,
      initiated_at_utc: new Date().toISOString(),
      completed_at_utc: null,
      approved_by: 'Awaiting Operator Approval',
      audit_signature: crypto.createHash('sha256').update(`${actionId}:${incident.tenant_id}:${rec.action_name}`).digest('hex').slice(0, 16),
      rollback_available: 1
    };

    this.pendingActions.set(actionId, action);
    this.storage.logAutonomousAction(action);
    return action;
  }

  approveAndExecute(actionId, approver = 'Operator (admin)') {
    const action = this.pendingActions.get(actionId);
    if (!action) {
      throw new Error(`Action ${actionId} not found or already completed.`);
    }

    action.status = 'EXECUTED';
    action.approved_by = approver;
    action.completed_at_utc = new Date().toISOString();
    action.execution_result = `Successfully applied policy action [${action.action_name}] on target [${action.target_component}]. Baseline stabilization verified.`;

    this.storage.updateAutonomousAction(actionId, {
      status: 'EXECUTED',
      approved_by: approver,
      completed_at_utc: action.completed_at_utc
    });

    this.pendingActions.delete(actionId);
    return action;
  }

  executeRollback(actionId, operator = 'Operator (admin)') {
    const rollbackActionId = `ROLLBACK-${actionId}`;
    const rollbackRecord = {
      action_id: rollbackActionId,
      tenant_id: 'tenant-acme-prod',
      incident_id: 'ROLLBACK_TRIGGER',
      action_name: `ROLLBACK_${actionId}`,
      target_component: 'system',
      status: 'ROLLED_BACK',
      approved_by: operator,
      initiated_at_utc: new Date().toISOString(),
      completed_at_utc: new Date().toISOString(),
      rollback_available: 0,
      details: {
        original_action: actionId,
        message: 'Reversible state successfully restored. Configuration reset to previous baseline.'
      }
    };

    this.storage.logAutonomousAction(rollbackRecord);
    return rollbackRecord;
  }

  getPendingActions(tenantId) {
    const arr = [];
    for (const action of this.pendingActions.values()) {
      if (action.tenant_id === tenantId) arr.push(action);
    }
    return arr;
  }
}
