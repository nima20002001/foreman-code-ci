import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { AcceptedExecutionBinding } from './nativeComposition.js'
import type { RemoteCommitFacts, RemoteResultTransaction } from '../runs/remote/resultBridge.js'
import type { RemoteReceiptDomain } from './remoteReceiptCommit.js'
import type { RunOwnership } from '../runs/ownership.js'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import { remoteStopChannel } from '../../../test/helpers/remoteStopChannel.js'
import { WorkerExecutionPolicy } from '../settings/workerExecution.js'

const ports = vi.hoisted(() => ({
  binding: undefined as AcceptedExecutionBinding | undefined,
  connection: undefined as DeviceSessionBinding | undefined,
  facts: undefined as RemoteCommitFacts | undefined,
  prefetch: vi.fn(),
}))
vi.mock('./persistence.js', () => ({
  readDispatchIntent: async () => ports.binding!.intent,
  readAcceptedPlacement: async () => ports.binding!.placement,
  readNativePlacement: async () => ({}),
}))
vi.mock('../runs/remote/persistence.js', () => ({ readReconciledDispatchIntent: async () => ports.binding!.intent }))
vi.mock('./executionBinding.js', () => ({ readNativeExecutionBinding: () => ({
  workingTree: { canonicalCwd: '/project' }, materialization: { state: 'running' },
}) }))
vi.mock('../runs/remote/workflowPhysicalVerification.js', () => ({
  createRemoteWorkflowPhysicalVerification: () => ({ prefetch: ports.prefetch }),
}))
vi.mock('./remoteReceiptCommit.js', () => ({
  reserveRemoteDispatchOrigin: async () => {},
  OwnedRemoteReceiptCommit: class {
    constructor(private owner: RunOwnership, _receipt: unknown, _connection: unknown,
      private domain: RemoteReceiptDomain) {}
    transaction<T>(_id: string, work: (transaction: RemoteResultTransaction) => Promise<T>): Promise<T> {
      const publish: RemoteResultTransaction['accept'] = async evidence => {
        await this.domain.publishNative({} as GraphTransactionSql, this.owner, evidence)
        ports.facts!.lastSequence = evidence.receipt.sequence
        ports.facts!.lastReceipt = evidence.receipt
        ports.facts!.native = evidence.receipt.native ?? null
      }
      return work({ authority: async () => ports.facts!, accept: publish, retain: publish,
        reject: async () => { throw new Error('Original authenticated receipt rejected') } })
    }
  },
}))
import { createProductionRemoteWorkflow } from './productionRemoteWorkflow.js'

it('refreshes the receipt and history together when physical prefetch changes the authenticated connection', async () => {
  const f = remoteStopChannel()
  ports.binding = { intent: f.intent, placement: f.placement }
  ports.facts = f.facts
  ports.connection = f.binding
  let reconnected = false
  // The physical port models a completed same-boot reconnect; the production receipt verifier and proxy stay real.
  ports.prefetch.mockImplementation(async (_receipt, _placement, source) => {
    if (source.type === 'history' && !reconnected) {
      reconnected = true
      ports.connection = { ...f.binding, connectionGeneration: f.binding.connectionGeneration + 1,
        connectionEpoch: 'replacement-epoch' }
    }
    return { kind: 'original-remote-physical' }
  })
  const generations: number[] = []
  const endpoint = { ...f.endpoint, currentBinding: () => ports.connection,
    captureRequest: () => {
      generations.push(ports.connection!.connectionGeneration)
      return { ...f.main.captureRequest('execution-v1'), binding: ports.connection! }
    } }
  const owner = { runId: 'run', assertOwned() {}, oneShotConnection: () => ({
    transaction: async (work: (sql: GraphTransactionSql) => Promise<void>) => work({} as GraphTransactionSql),
  }) } as unknown as RunOwnership
  const composition = createProductionRemoteWorkflow({ pool: {} as pg.Pool,
    locations: {} as Parameters<typeof createProductionRemoteWorkflow>[0]['locations'],
    producer: () => undefined, endpoint: () => endpoint as unknown as
      ReturnType<Parameters<typeof createProductionRemoteWorkflow>[0]['endpoint']>,
    workerExecution: new WorkerExecutionPolicy({ enabled: true, managedBy: 'settings' }),
    execution: async () => ({ id: 'execution', runId: 'run', workflowNodeId: 'node', agentId: 'agent',
      agentConfigurationVersionId: 'configuration', attempt: 1, state: 'running', input: {},
      createdAt: '2026-10-01T00:00:00.000Z', workingDirectory: '/project' }),
  })
  try {
    await composition.prepare('execution')
    const manager = composition.manager({ executionId: 'execution', agentId: 'agent', configuration: f.configuration,
      workingDirectory: '/project', harness: 'codex' }, () => owner)!
    const session = await manager.attachSession(f.session, { correlationId: 'execution:execution', request: {
      executionId: 'execution', runId: 'run', workspaceId: 'workspace', workflowNodeId: 'node',
      workingDirectory: '/project', runtimeDirectory: '/runtime', configuration: f.configuration, input: {},
    } })
    await expect(manager.history(session)).resolves.toMatchObject({ events: [], pendingInteractions: [] })
    expect(f.requests.filter(frame => frame.method === 'history')).toHaveLength(2)
    expect(generations).toContain(f.binding.connectionGeneration + 1)
    expect(f.requests.filter(frame => frame.method === 'reattach')).toHaveLength(1)
    expect(f.requests.some(frame => frame.method === 'prepare')).toBe(false)
    expect(f.requests.some(frame => frame.method === 'control' || frame.method === 'start-turn')).toBe(false)
    expect(f.facts.lastReceipt?.native?.sessionId).toBe(session.nativeSessionId)
  } finally { await f.close() }
})
