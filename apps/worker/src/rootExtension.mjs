import { loadWorkerPairing } from '../../../packages/contracts/src/deviceIdentityNode.ts';
import { WORKSPACE_ROOT_EXTENSION } from '../../../packages/contracts/src/workspaceRootPolicies.ts';
import { createWorkspaceRootWorkerHandler } from '../../../apps/api/src/modules/sources/rootAttestation.ts';
import { loadApprovedRoots } from './approvedRoots.mjs';
import { WorkerError } from './diagnostics.mjs';

export async function approvedRootExtensions(stateDirectory, pairing, bootId) {
  const approved = await loadApprovedRoots(stateDirectory, pairing);
  if (!approved) return [];
  return [{ namespace: WORKSPACE_ROOT_EXTENSION.namespace, version: WORKSPACE_ROOT_EXTENSION.version,
    role: 'server', maxJsonBytes: WORKSPACE_ROOT_EXTENSION.maxPayloadBytes, maxBinaryBytes: 0,
    async handle(payload, context) {
      let currentPairing;
      const handler = createWorkspaceRootWorkerHandler(async () => {
        const current = await loadApprovedRoots(stateDirectory, currentPairing);
        if (!current) throw new WorkerError('approved_roots_unavailable');
        return current;
      }, async (request) => {
        context.signal.throwIfAborted();
        currentPairing = await loadWorkerPairing(stateDirectory);
        const binding = context.binding;
        if (!binding || binding.bootId !== bootId || !binding.connectionEpoch || !Number.isSafeInteger(binding.connectionGeneration) || binding.connectionGeneration < 1
          || ['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision'].some((key) => binding[key] !== currentPairing[key])
          || currentPairing.mainId !== pairing.mainId || currentPairing.deviceId !== pairing.deviceId || currentPairing.workerInstallationId !== pairing.workerInstallationId
          || currentPairing.mainPublicKeyFingerprint !== pairing.mainPublicKeyFingerprint
          || Date.parse(currentPairing.expiresAt) <= Date.now() || (context.bytes?.byteLength ?? 0) !== 0) throw new WorkerError('workspace_root_authentication_required');
        if (request.operation === 'workspace-roots.configuration') return;
        const selection = request.operation === 'workspace-roots.source-namespace' ? request.policy : request.selection;
        const base = approved.bases.find((base) => base.baseId === selection.allowedBaseId);
        if (selection.hostRef.kind !== 'device' || selection.hostRef.mainId !== currentPairing.mainId || selection.hostRef.deviceId !== currentPairing.deviceId
          || selection.configurationRevision !== approved.configurationRevision || !base || !base.accessModes.includes(selection.accessMode)) throw new WorkerError('workspace_root_scope_denied');
        if (request.operation === 'workspace-roots.source-namespace') {
          if (selection.applicationInstallationId !== currentPairing.workerInstallationId || !selection.registration
            || ['workerInstallationId', 'keyRevision', 'authorizationRevision'].some((key) => selection.registration[key] !== currentPairing[key])) throw new WorkerError('workspace_root_scope_denied');
        }
      });
      const result = await handler(payload);
      context.signal.throwIfAborted();
      return { payload: result };
    },
  }];
}
