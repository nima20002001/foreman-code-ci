import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { RemoteOperationReceiptSchema } from '@foreman-code/contracts/remote-execution'
import { RemoteExecutionRpcRequestSchema } from '@foreman-code/contracts/remote-execution-rpc'
import type { NativeManagerResolutionContext } from '../interactions/runtimePorts.js'
import type { RemoteResultCommitPort } from '../runs/remote/resultBridge.js'
import { WorkerExecutionPolicy } from '../settings/workerExecution.js'
import { deriveDispatch, freezePlacement } from './binding.js'
import { remoteNativeManager } from './workerCarrier.js'
import { deferred } from '../../../test/helpers/deferred.js'
import { input } from '../../../test/fixtures/codex-test-helpers.js'

it.each(['shared', 'distinct'] as const)(
  'retains authentication for overlapping identical receipts while an observation commit is in flight (%s payload)',
  async payloadIdentity => {
  const source = input('/project')
  delete source.environment
  const { request } = source
  const configuration = request.configuration
  const mainId = randomUUID()
  const deviceId = randomUUID()
  const workerInstallationId = randomUUID()
  const digest = 'a'.repeat(64)
  const connection = { mainId, deviceId, workerInstallationId, bootId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1 }
  const placement = freezePlacement({ schemaVersion: 1, mainId, runId: request.runId,
    nodeId: request.workflowNodeId, hostRef: { kind: 'device', mainId, deviceId },
    registration: { workerInstallationId, keyRevision: 1, authorizationRevision: 1 },
    mainInstallationId: 'main-installation',
    destination: { canonicalProjectRoot: '/project', canonicalCwd: '/project', managedRuntimeRoot: '/runtime',
      directoryIdentityHash: digest, rootPolicyId: 'policy', rootPolicyRevision: '1', locationRevision: '1',
      attestationId: 'attestation', attestationHash: digest },
    source: { revisionId: 'source', manifestDigest: digest, materializationId: 'materialization',
      materializationDigest: digest },
    payload: { kind: 'agent', agentId: configuration.agentId, agentConfigurationVersionId: configuration.id,
      driverId: 'codex', driverRevision: '1', instanceId: 'instance', instanceRevision: '1',
      harnessInstallationId: 'harness', installationFingerprint: digest, runtimeContractVersion: 1,
      protocolRevision: '1', credentialScopeRefs: [] },
  })
  const intent = deriveDispatch(placement, { executionId: request.executionId, occurrenceId: null,
    occurrenceIndex: 0, technicalAttempt: 1, attemptId: 'attempt', operationId: 'operation',
    inputDigest: `sha256:${digest}`, owner: { grantId: 'grant', epoch: '1' } })
  const session = { harness: 'codex' as const, providerVersion: 'fixture', nativeSessionId: 'native-session' }
  const receipt = RemoteOperationReceiptSchema.parse({ schemaVersion: 1, intent, connection,
    workerIncarnationId: randomUUID(), sequence: 1, phase: 'running',
    native: { sessionId: session.nativeSessionId, turnId: 'native-turn', processIdentityDigest: digest },
    entryAttempted: true, turnEntryAttempted: true,
    turnInput: { correlationId: `execution:${request.executionId}`, promptDigest: digest },
    stopFence: false, controls: [],
  })
  const status = { status: 'known' as const, receipt }
  const commitEntered = deferred()
  const releaseCommit = deferred()
  let holdCommit = false
  let commits = 0
  const port: RemoteResultCommitPort = {
    transaction: async (_operationId, work) => work({
      authority: async () => {
        if (holdCommit) {
          holdCommit = false
          commitEntered.resolve()
          await releaseCommit.promise
        }
        return { intent, placement, originalConnection: connection, originalIncarnationId: receipt.workerIncarnationId,
          grantIsLive: true, lastSequence: 0, lastReceipt: null, native: receipt.native!, terminal: null }
      },
      accept: async () => { commits++ },
      reject: async (_receipt, reason) => { throw new Error(`Unexpected receipt rejection: ${reason}`) },
    }),
  }
  const manager = remoteNativeManager({ agentId: configuration.agentId, configuration, harness: 'codex',
    executionId: request.executionId, workingDirectory: request.workingDirectory } as NativeManagerResolutionContext,
  { intent, placement }, {
    carrier: { capture: () => ({ identity: connection, request: async (_namespace, raw) => {
      const frame = RemoteExecutionRpcRequestSchema.parse(raw)
      if (frame.method === 'prepare') return { payload: { session, status } }
      if (frame.method === 'status') return { payload: payloadIdentity === 'shared' ? status : structuredClone(status) }
      if (frame.method === 'pending') return { payload: undefined }
      throw new Error(`Unexpected request: ${frame.method}`)
    } }) },
    beforePrepare: async () => undefined,
    commit: async (_receipt, authenticated) => {
      expect(authenticated).toEqual(connection)
      return port
    },
    controlFor: async () => { throw new Error('Unexpected native control') },
    workerExecution: new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' }),
  })
  await manager.createSession({ request, correlationId: `execution:${request.executionId}` })
  holdCommit = true
  const observing = manager.observeBoundary(session)
  await commitEntered.promise
  const overlapping = [manager.observeBoundary(session), manager.observeBoundary(session)]
  const result = Promise.allSettled(overlapping)
  try {
    // This later read crosses the same carrier awaits after both replies have registered,
    // while their observations remain queued behind the held commit.
    await manager.pending(session)
    releaseCommit.resolve()
    await observing
    expect(await result).toEqual([
      { status: 'fulfilled', value: undefined },
      { status: 'fulfilled', value: undefined },
    ])
    await manager.observeBoundary(session)
    expect(commits).toBe(5)
  } finally {
    releaseCommit.resolve()
    await Promise.allSettled([observing, ...overlapping])
  }
  },
)
