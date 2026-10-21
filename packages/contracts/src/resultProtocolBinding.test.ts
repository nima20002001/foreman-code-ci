import { describe, expect, it } from 'vitest';
import { AcceptedNodePlacementSchema } from './nodePlacement.js';
import { COORDINATION_RESULT_PROTOCOL } from './coordinationResult.js';

const digest = 'a'.repeat(64);
const mainId = '11111111-1111-4111-8111-111111111111';
const binding = { schemaVersion: 1, mainId, runId: 'run', nodeId: 'worker',
  hostRef: { kind: 'main', mainId }, registration: null, mainInstallationId: 'main-installation',
  destination: { canonicalProjectRoot: '/project', canonicalCwd: '/project', managedRuntimeRoot: '/runtime',
    directoryIdentityHash: digest, rootPolicyId: 'policy', rootPolicyRevision: '1', locationRevision: '1',
    attestationId: 'attestation', attestationHash: digest },
  source: { revisionId: 'revision', manifestDigest: digest, materializationId: 'materialization', materializationDigest: digest },
  payload: { kind: 'agent', agentId: 'agent', agentConfigurationVersionId: 'configuration',
    driverId: 'driver', driverRevision: 'driver-revision', instanceId: 'instance', instanceRevision: 'instance-revision',
    harnessInstallationId: 'harness', installationFingerprint: 'fingerprint', runtimeContractVersion: 1,
    protocolRevision: 'protocol', credentialScopeRefs: [] }, bindingHash: digest };

describe('optional immutable result protocol binding', () => {
  it('reads old launch facts unchanged and retains an explicitly pinned protocol', () => {
    expect(AcceptedNodePlacementSchema.parse(binding)).toEqual(binding);
    const marked = { ...binding, payload: { ...binding.payload, resultProtocol: COORDINATION_RESULT_PROTOCOL } };
    expect(AcceptedNodePlacementSchema.parse(marked)).toEqual(marked);
    expect(AcceptedNodePlacementSchema.safeParse({ ...binding, payload: { ...binding.payload, resultProtocol: 'unknown' } }).success).toBe(false);
  });
});
