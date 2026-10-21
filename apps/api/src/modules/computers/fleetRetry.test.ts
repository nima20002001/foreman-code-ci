import Fastify from 'fastify'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { registerGraphqlMcp } from '../../mcp/unified/transport.js'
import type { OperatorServices } from '../../mcp/operator/types.js'
import type { PostgresAccessService } from '../access/postgres.js'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { COMPUTER_MAINTENANCE_NAMESPACE, MaintenanceRequestSchema, type MaintenanceTask } from '@foreman-code/contracts/computer-maintenance'
import { FleetMaintenanceService, type FleetSources } from './fleet.js'
import type { ComputerMaintenance } from './maintenance.js'
import { pairedComputerFixture } from './pairedComputer.testSupport.js'

afterEach(() => vi.restoreAllMocks())

it.each(['lost-reply', 'offline'] as const)('resumes an unresolved maintenance target after %s using the saved dispatch', async failure => {
  const f = pairedComputerFixture()
  const accepted = new Map<string, MaintenanceTask>()
  const requests: unknown[] = []
  let disconnected = true
  let catalog = 'original'
  const sources: FleetSources = {
    codexUserMcpServers: async () => ({ [catalog]: { transport: 'http', url: `https://${catalog}.example/mcp` } }),
    claudeUserMcpServers: async () => ({}), codexPlugins: async () => [], codexMarketplaces: async () => [],
    claudePlugins: async () => ({ plugins: [], marketplaces: [] }),
  }
  const endpoint = { capabilities: () => [{ namespace: COMPUTER_MAINTENANCE_NAMESPACE, mainCanRequest: true }],
    request: async (_id: string, _namespace: string, payload: unknown) => {
      const input = MaintenanceRequestSchema.parse(payload)
      if (input.operation !== 'start') throw new Error('Expected an idempotent start retry')
      requests.push(input)
      if (disconnected && failure === 'offline') throw new Error('Computer offline')
      let task = accepted.get(input.commandId)
      if (!task) {
        task = { id: input.commandId, kind: input.task.kind, state: 'succeeded', summary: 'Synced', outputTail: '',
          startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z' }
        accepted.set(input.commandId, task)
      }
      if (disconnected) throw new Error('Reply lost after acceptance')
      return { payload: { operation: 'start', task } }
    } }
  const create = () => new FleetMaintenanceService(f.pool, f.mainId, () => endpoint, f.commands,
    { drain: async () => {} } as ComputerMaintenance, sources)
  const fleet = create()
  const input = { commandId: randomUUID(), targets: [f.target], task: { kind: 'sync-mcp' as const } }
  const operator = { computerMaintenance: fleet, commands: f.commands } as unknown as OperatorServices
  const access = { authenticate: async (token: string) => token === 'owner' ? f.principal
    : { ...f.principal, id: 'denied', grants: [] } } as unknown as PostgresAccessService
  const app = Fastify()
  registerGraphqlMcp(app, { access, operator })
  const call = async (token: string) => {
    const response = await app.inject({ method: 'POST', url: '/mcp',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'computers_maintenance_start', arguments: input } } })
    const data = response.body.split('\n').find(line => line.startsWith('data: '))
    return decodeMcpToolResult((data ? JSON.parse(data.slice(6)) : response.json()).result)
  }
  try {
    expect(await call('denied')).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
    const first = await call('owner') as { computers: unknown[] }
    expect(first.computers[0]).toMatchObject({ task: null, error: expect.any(String) })
    disconnected = false
    catalog = 'changed'
    const restarted = create()
    operator.computerMaintenance = restarted
    const replay = await call('owner') as { computers: unknown[] }
    expect(replay.computers[0]).toMatchObject({ task: { id: input.commandId, state: 'succeeded' }, error: null })
    expect(requests).toHaveLength(2)
    expect(requests[1]).toEqual(requests[0])
    expect(accepted.size).toBe(1)
    await restarted.drain()
  } finally {
    await app.close()
    await fleet.drain()
    await f.pool.end()
  }
})
