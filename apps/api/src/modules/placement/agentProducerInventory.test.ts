import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import { canonicalGraphJson, makeCurrentWorkflowFixture, RunStartV3InputSchema,
  type SavedWorkflowVersion } from '@foreman-code/contracts/wave25'
import type { CanonicalMachineReference } from '@foreman-code/contracts/device-identity'
import { prepareRunStart, START_PREPARATION_TIMEOUT_MS } from '../runs/startPreparation.js'
import { AgentPlacementProducer } from './agentProducer.js'
import { DomainError } from '../errors.js'

function fixture(kind: 'agent' | 'job', refresh: (
  hosts: readonly CanonicalMachineReference[], signal?: AbortSignal,
) => Promise<void>, assertBundleReady?: (host: CanonicalMachineReference) => Promise<void>) {
  const mainId = randomUUID()
  const seed = makeCurrentWorkflowFixture('inventory-admission', 'single')
  const version: SavedWorkflowVersion = structuredClone(seed.version)
  if (kind === 'job') {
    version.definition.nodes = [{ kind: 'job', id: version.entryNodeId, name: 'Build',
      jobDefinitionId: 'definition', jobDefinitionRevision: 1, jobDefinitionVersionId: 'job-version' }]
    version.agentConfigurationVersionIds = {}
  } else {
    const node = version.definition.nodes[0]!
    if (node.kind === 'job') throw new Error('Expected an Agent fixture.')
    node.artifactOutputs = { version: 1, outputKeys: ['report'] }
  }
  version.contentHash = `sha256:${createHash('sha256').update(canonicalGraphJson({
    definition: version.definition, configurations: version.agentConfigurationVersionIds, entryNodeId: version.entryNodeId,
  })).digest('hex')}`
  let transaction = false
  const client = { query: async (text: string) => {
    if (text.startsWith('begin')) transaction = true
    if (text === 'commit' || text === 'rollback') transaction = false
    return { rows: text.includes('from workflow_versions') ? [{ id: version.id, workspace_id: version.workspaceId,
      workflow_id: version.workflowId, version: version.version, entry_node_id: version.entryNodeId,
      execution_semantics_version: 3, record: version }] : [], rowCount: 1 }
  }, on: () => {}, removeListener: () => {}, release: vi.fn() }
  const producer = new AgentPlacementProducer({ connect: async () => client } as unknown as pg.Pool,
    mainId, {} as never, {} as never, {} as never, { codex: 'suite' }, undefined, undefined,
    (hosts, signal) => { expect(transaction).toBe(false); return refresh(hosts, signal) }, undefined,
    assertBundleReady)
  const input = RunStartV3InputSchema.parse({ workspaceId: version.workspaceId, workflowId: version.workflowId,
    workflowVersionId: version.id, expectedAgentConfigurationVersionIds: version.agentConfigurationVersionIds,
    commandId: 'start-inventory', executionSemanticsVersion: 3, expectedWorkflowRevision: 1,
    expectedLocationRevision: 1, input: {} })
  const principal = { id: 'operator', name: 'Operator', audience: 'operator' as const,
    grants: [], expiresAt: '2099-01-01T00:00:00Z', revokedAt: null }
  return { producer, input, principal, mainId, client }
}

it('rejects an unavailable bundle before placement inventory and source preparation', async () => {
  const refresh = vi.fn(async () => {})
  const failure = new DomainError('WORKER_VERSION_SKEW', 'The selected computer needs an update.', 409)
  const assertBundleReady = vi.fn(async () => { throw failure })
  const f = fixture('agent', refresh, assertBundleReady)
  await expect(f.producer.prepare(f.input, f.principal)).rejects.toBe(failure)
  expect(assertBundleReady).toHaveBeenCalledWith({ kind: 'main', mainId: f.mainId })
  expect(refresh).not.toHaveBeenCalled()
})

it('does not discover any Agent hosts for a Job-only Start', async () => {
  const refresh = vi.fn(async () => {})
  const f = fixture('job', refresh)
  await expect(f.producer.prepare(f.input, f.principal)).resolves.toBeUndefined()
  expect(refresh).not.toHaveBeenCalled()
})

it('refreshes only the saved Agent hosts outside the graph transaction and propagates Start cancellation', async () => {
  let entered!: () => void
  const discovering = new Promise<void>(resolve => { entered = resolve })
  const refresh = vi.fn(async (_hosts: readonly CanonicalMachineReference[], signal?: AbortSignal) => {
    entered()
    await new Promise<void>((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
    })
  })
  const f = fixture('agent', refresh)
  const controller = new AbortController()
  const start = f.producer.prepare(f.input, f.principal, controller.signal)
  await discovering
  expect(refresh).toHaveBeenCalledWith([{ kind: 'main', mainId: f.mainId }], controller.signal)
  const canceled = new Error('Start canceled during discovery')
  controller.abort(canceled)
  await expect(start).rejects.toBe(canceled)
  expect(f.client.release).toHaveBeenCalledTimes(1)
})

it('gives slow Agent host discovery the preparation budget instead of the quick Start deadline', async () => {
  vi.useFakeTimers()
  try {
    const discovery = START_PREPARATION_TIMEOUT_MS * 3
    let abortedAfterDiscovery: boolean | undefined
    const f = fixture('agent', async (_hosts, signal) => {
      await new Promise(resolve => setTimeout(resolve, discovery))
      abortedAfterDiscovery = signal?.aborted
    })
    const settled = prepareRunStart((signal, started) => f.producer.prepare(f.input, f.principal, signal,
      { source: 'mcp', sourcePreparationStarted: started })).catch((error: { code?: string }) => error.code)
    await vi.advanceTimersByTimeAsync(discovery + 1)
    expect(abortedAfterDiscovery).toBe(false)
    expect(await settled).not.toBe('RUN_START_PREPARATION_TIMEOUT')
  } finally { vi.useRealTimers() }
})

it('gives a slow Worker bundle readiness check the preparation budget instead of the quick Start deadline', async () => {
  vi.useFakeTimers()
  try {
    const readiness = START_PREPARATION_TIMEOUT_MS * 3
    let abortedAfterReadiness: boolean | undefined
    let signalOfStart: AbortSignal | undefined
    const f = fixture('agent', async () => {}, async () => {
      await new Promise(resolve => setTimeout(resolve, readiness))
      abortedAfterReadiness = signalOfStart?.aborted
    })
    const settled = prepareRunStart((signal, started) => {
      signalOfStart = signal
      return f.producer.prepare(f.input, f.principal, signal, { source: 'mcp', sourcePreparationStarted: started })
    }).catch((error: { code?: string }) => error.code)
    await vi.advanceTimersByTimeAsync(readiness + 1)
    expect(abortedAfterReadiness).toBe(false)
    expect(await settled).not.toBe('RUN_START_PREPARATION_TIMEOUT')
  } finally { vi.useRealTimers() }
})
