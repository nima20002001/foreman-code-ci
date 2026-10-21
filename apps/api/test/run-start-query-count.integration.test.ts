import { join } from 'node:path'
import { expect, it } from 'vitest'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { fixture, startInput } from './helpers/nodePlacementStartFixture.js'
import { admitRepeatRun } from '../src/modules/runs/repeatStartAdmission.js'
import { repeatStartPublication } from '../src/modules/run-graph/repeatStartPublication.js'
import { readRunAcceptedPlacements } from '../src/modules/placement/persistence.js'
import { WorkerExecutionPolicy } from '../src/modules/settings/workerExecution.js'
import { LocalProviderCredentials } from '../src/modules/provider-accounts/localCredentials.js'
import { ProviderAccountsRepository } from '../src/modules/provider-accounts/repository.js'
import { ProviderAccountsService } from '../src/modules/provider-accounts/service.js'
import { runtimeTimingChannel, type RuntimeTimingRecord } from '../src/infrastructure/runtimeTiming.js'

async function measureStart(work: () => Promise<unknown>) {
  let statements = 0
  const transactions: number[] = []
  const record = (message: unknown) => {
    const { phase } = message as RuntimeTimingRecord
    if (phase === 'sql.begin') statements = 0
    if (phase === 'sql.query') statements++
    if (phase === 'sql.commit') transactions.push(statements)
  }
  runtimeTimingChannel.subscribe(record)
  try {
    await work()
    expect(transactions.length).toBeGreaterThan(0)
    return transactions.at(-1)!
  } finally {
    runtimeTimingChannel.unsubscribe(record)
  }
}

it('starts additional Agents sharing a destination without repeating its transaction reads or per-node writes', async () => {
  const start = async (size: number) => {
    const f = await fixture()
    try {
      const originals = f.saveInput.graph.nodes.map(agentWorkflowNode)
      f.saveInput.graph.nodes = Array.from({ length: size }, (_, index) => ({
        ...structuredClone(originals[index % originals.length]!),
        id: `node-${index}`, placement: f.placement.local,
      }))
      f.saveInput.graph.entryNodeId = 'node-0'
      f.saveInput.graph.executionPolicy!.maxNodeExecutions = size
      f.saveInput.graph.edges = f.saveInput.graph.nodes.slice(1).map((node, index) => ({
        id: `edge-${index}`, kind: 'execution', source: `node-${index}`, target: node.id,
      }))
      const saved = await f.save('mcp')
      const credentials = new LocalProviderCredentials(join(f.base.db.directory, 'accounts'))
      const accounts = new ProviderAccountsService(f.base.db.pool,
        new ProviderAccountsRepository(f.base.db.pool, () => credentials.hostId()), credentials, {
          status: async () => ({ status: 'signed-in', identity: null }),
          login: async () => {}, logout: async () => {}, cancelLogin: async () => {}, close: async () => {},
        }, f.base.commands)
      const publication = { ...repeatStartPublication, placementAdmission: f.placement.producer,
        accountBindings: accounts.acceptedBindings,
        workerExecution: new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' }) }
      const input = startInput(f, saved)
      let accepted!: Awaited<ReturnType<typeof admitRepeatRun>>
      const statements = await measureStart(async () => {
        accepted = await admitRepeatRun(f.base.db.pool, f.base.locations, f.base.writer.principal,
          'mcp', input, publication)
      })
      expect(accepted.value.executionState).toBe('queued')
      const placements = await readRunAcceptedPlacements(f.base.db.pool, accepted.value.id)
      expect(placements.map(pin => pin.nodeId)).toEqual(f.saveInput.graph.nodes.map(node => node.id))
      for (const pin of placements) {
        const node = agentWorkflowNode(f.saveInput.graph.nodes.find(node => node.id === pin.nodeId))
        expect(pin.payload).toMatchObject({ kind: 'agent', agentId: node.agentId,
          agentConfigurationVersionId: saved.version.agentConfigurationVersionIds[node.agentId] })
        expect(pin.hostRef).toEqual(f.placement.local.hostRef)
        const binding = await accounts.runtimeBinding('run-node', `${accepted.value.id}:${node.id}`,
          f.base.f.configurations.find(configuration => configuration.agentId === node.agentId)!.harness)
        expect(binding).toEqual(pin.payload.kind === 'agent' ? pin.payload.accountBinding : undefined)
      }
      expect(await admitRepeatRun(f.base.db.pool, f.base.locations, f.base.writer.principal,
        'http', input, publication)).toEqual({ ...accepted, replayed: true })
      expect(await readRunAcceptedPlacements(f.base.db.pool, accepted.value.id)).toEqual(placements)
      return statements
    } finally {
      await f.close()
    }
  }
  const two = await start(2)
  const three = await start(3)
  console.info('Start admission statements', { two, three })
  expect(three).toBeLessThanOrEqual(two)
}, 120_000)

it('rolls back Start when a placement profile changes after the initial checks and before commit', async () => {
  const f = await fixture()
  try {
    const saved = await f.save('mcp')
    await expect(admitRepeatRun(f.base.db.pool, f.base.locations, f.base.writer.principal, 'mcp',
      startInput(f, saved), { ...repeatStartPublication, placementAdmission: f.placement.producer,
        workerExecution: new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' }),
        initializeLocked: async (sql, accepted) => {
          const result = await repeatStartPublication.initializeLocked(sql, accepted)
          await sql.query(`update harness_instance_settings set record=jsonb_set(record,'{enabled}','false'::jsonb)
            where instance_id=$1`, [f.placement.remote.instanceId])
          return result
        },
      })).rejects.toMatchObject({ code: 'PLACEMENT_ADMISSION_CONFLICT' })
    expect((await f.base.db.pool.query('select id from runs where workflow_id=$1',
      [saved.version.workflowId])).rows).toEqual([])
    expect((await f.base.db.pool.query<{ enabled: boolean }>(
      "select (record->>'enabled')::boolean as enabled from harness_instance_settings where instance_id=$1",
      [f.placement.remote.instanceId])).rows.every(row => row.enabled)).toBe(true)
  } finally {
    await f.close()
  }
}, 120_000)
