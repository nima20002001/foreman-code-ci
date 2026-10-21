import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { HarnessExecutionRequestSchema, SessionPreferencesSchema } from '@foreman-code/contracts'
import { AcceptedNodePlacementSchema, DispatchIntentSchema, NativeExecutionPlacementSchema } from '@foreman-code/contracts/node-placement'
import { RemoteApplicationAccessSchema } from '@foreman-code/contracts/remote-execution'
import { negotiateDeviceExtensions } from '@foreman-code/contracts/device-application'
import { RemoteExecutionRpcRequestSchema } from '@foreman-code/contracts/remote-execution-rpc'
import { input } from '../../../test/fixtures/codex-test-helpers.js'
import { freezePlacement, deriveDispatch } from './binding.js'
import { remoteNativeManager } from './workerCarrier.js'
import { WorkerExecutionPolicy } from '../settings/workerExecution.js'

// Strict preparation contract shipped before session continuation support.
const historicalPrepare = z.object({ method: z.literal('prepare'), intent: DispatchIntentSchema,
  placement: AcceptedNodePlacementSchema, executionPlacement: NativeExecutionPlacementSchema.optional(),
  request: HarnessExecutionRequestSchema, applicationAccess: RemoteApplicationAccessSchema.optional(),
  sessionPreferences: SessionPreferencesSchema.optional() }).strict()

function fixture({ continuationSupported }: { continuationSupported: boolean }) {
  const { request } = input('/project')
  const start = { request }
  const mainId = randomUUID()
  const deviceId = randomUUID()
  const workerInstallationId = randomUUID()
  const digest = 'a'.repeat(64)
  const placement = freezePlacement({ schemaVersion: 1, mainId, runId: request.runId, nodeId: request.workflowNodeId,
    mainInstallationId: 'installation', hostRef: { kind: 'device', mainId, deviceId },
    registration: { workerInstallationId, keyRevision: 1, authorizationRevision: 1 },
    destination: { canonicalProjectRoot: '/project', canonicalCwd: '/project', managedRuntimeRoot: '/runtime',
      directoryIdentityHash: digest, rootPolicyId: 'policy', rootPolicyRevision: '1', locationRevision: '1',
      attestationId: 'attestation', attestationHash: digest },
    source: { revisionId: 'source', manifestDigest: digest, materializationId: 'materialization', materializationDigest: digest },
    payload: { kind: 'agent', agentId: request.configuration.agentId,
      agentConfigurationVersionId: request.configuration.id, driverId: 'codex', driverRevision: '1',
      instanceId: 'instance', instanceRevision: '1', harnessInstallationId: 'harness', installationFingerprint: digest,
      runtimeContractVersion: 1, protocolRevision: '1', credentialScopeRefs: [] },
  })
  const intent = deriveDispatch(placement, { executionId: request.executionId, occurrenceId: null, occurrenceIndex: 0,
    technicalAttempt: 1, attemptId: 'attempt', operationId: 'operation', inputDigest: `sha256:${digest}`,
    owner: { grantId: 'grant', epoch: '1' } })
  const base = { namespace: 'execution-v1', version: 1, maxJsonBytes: 1_048_576, maxBinaryBytes: 0 }
  const preparation = { ...base, namespace: 'execution-prepare', version: 2 }
  const negotiated = negotiateDeviceExtensions([{ ...base, role: 'client' }, { ...preparation, role: 'client' }],
    [{ ...base, role: 'server' }, ...(continuationSupported ? [{ ...preparation, role: 'server' as const }] : [])])
  const delivered = vi.fn(async (namespace: string, payload: unknown) => {
    if (namespace === 'execution-v1') historicalPrepare.parse(payload)
    else RemoteExecutionRpcRequestSchema.parse(payload)
    throw new Error('supported native entry')
  })
  const beforePrepare = vi.fn(async () => undefined)
  const manager = remoteNativeManager({ executionId: request.executionId, agentId: request.configuration.agentId,
    configuration: request.configuration, harness: 'codex', workingDirectory: request.workingDirectory }, { intent, placement }, {
    carrier: { capture: () => ({ identity: { mainId, deviceId, workerInstallationId, keyRevision: 1,
      authorizationRevision: 1, bootId: randomUUID(), connectionGeneration: 1 },
      supports: (namespace: string) => negotiated.some(extension => extension.namespace === namespace && extension.mainCanRequest),
      request: delivered }) },
    workerExecution: new WorkerExecutionPolicy({ enabled: true, managedBy: 'settings' }), beforePrepare,
    commit: vi.fn(), controlFor: vi.fn(),
  })
  return { start: { ...start, correlationId: `execution:${request.executionId}` }, manager, delivered, beforePrepare,
    intent, placement }
}

describe('worker preparation schema negotiation', () => {
  it.each([false, true, false])('rejects continuation before dispatch when the worker revision is unavailable (%s)', async supported => {
    const f = fixture({ continuationSupported: supported })
    const sessionContinuation = { previousExecutionId: 'previous-execution', previousOperationId: 'previous-operation',
      session: { harness: 'codex' as const, providerVersion: 'fixture', nativeSessionId: 'original-session' } }
    const pins = structuredClone({ intent: f.intent, placement: f.placement, sessionContinuation })
    if (supported) {
      await expect(f.manager.createSession({ ...f.start, sessionContinuation })).rejects.toThrow('supported native entry')
      expect(f.delivered).toHaveBeenCalledWith('execution-prepare', expect.objectContaining({ sessionContinuation }), expect.any(Object))
    } else {
      await expect(f.manager.createSession({ ...f.start, sessionContinuation }))
        .rejects.toMatchObject({ code: 'REMOTE_EXECUTION_INCOMPATIBLE' })
      expect(f.delivered).not.toHaveBeenCalled()
      expect(f.beforePrepare).not.toHaveBeenCalled()
    }
    expect({ intent: f.intent, placement: f.placement, sessionContinuation }).toEqual(pins)
  })
  it('keeps a preparation without continuation compatible with the strict historical receiver', async () => {
    const f = fixture({ continuationSupported: false })
    await expect(f.manager.createSession(f.start)).rejects.toThrow('supported native entry')
    expect(f.delivered).toHaveBeenCalledWith('execution-v1', expect.objectContaining({ method: 'prepare' }), expect.any(Object))
  })
})
