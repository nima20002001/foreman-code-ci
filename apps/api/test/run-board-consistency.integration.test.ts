import type pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { describe, expect, it, vi } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { RunBoardSnapshotGetResultSchema } from '@foreman-code/contracts/run-snapshots'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import { RunHistoryService } from '../src/modules/runs/history.js'
import { intervalRuntime } from './helpers/intervalRuntime.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

describe.runIf(postgresEnabled)('saved Board read consistency', () => {
  it.each(['http', 'mcp'] as const)('keeps one lifecycle and interval cut through %s', async transport => {
    const { runtime, f, watcher, checkStarted, checkGate, workerGate } = await intervalRuntime()
    const commands = new PostgresCommandCoordinator(runtime.db.pool)
    type Args = ConstructorParameters<typeof RunManagementService>
    const runs = new RunManagementService(runtime.db.pool, commands, runtime.runs, runtime.engine, {} as Args[4])
    let interleaved = false
    const readPool = { connect: async () => {
      const client = await runtime.db.pool.connect()
      const query = client.query.bind(client)
      const release = client.release.bind(client)
      client.query = (async (text: string, values?: unknown[]) => {
        const result = await query(text, values)
        const row = result.rows[0] as Record<string, unknown> | undefined
        if (!interleaved && row?.snapshot_id === f.run.id && row.execution_state === 'running') {
          interleaved = true
          checkGate.resolve()
          workerGate.resolve()
          await vi.waitFor(async () => {
            const details = await runtime.runs.getDetails(f.run.workspaceId, f.run.id)
            expect(details?.executions.every(execution => execution.state === 'completed')).toBe(true)
          }, { timeout: 10_000 })
          await runtime.stop()
          await runtime.engine.cancel(f.run.id)
          if (finished) await Promise.allSettled([finished])
        }
        return result
      }) as pg.PoolClient['query']
      client.release = error => {
        client.query = query
        client.release = release
        release(error)
      }
      return client
    } } as pg.Pool
    const history = new RunHistoryService(readPool)
    const snapshot = vi.spyOn(runs.history, 'snapshot').mockImplementation((...args) => history.snapshot(...args))
    const app = buildApp({ operator: { access: runtime.access, services: { runs, commands } as unknown as OperatorServices },
      readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } } })
    const clients: Client[] = []
    let finished: Promise<unknown> | undefined
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const viewer = await runtime.access.issue({ name: 'Board reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 300_000), grants: [{ actions: ['runs:read'],
          scope: { workspaceIds: [f.run.workspaceId], runIds: [f.run.id] } }] })
      const client = new Client({ name: 'board-reader', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        authProvider: { token: async () => viewer.token },
      }))
      finished = runtime.engine.start(f.run.id)
      await checkStarted.promise
      const args = { workspaceId: f.run.workspaceId, workflowId: f.run.workflowId, runId: f.run.id }
      let raw: unknown
      if (transport === 'http') {
        const response = await app.inject({ method: 'GET',
          url: `/api/management/workspaces/${args.workspaceId}/workflows/${args.workflowId}/runs/${args.runId}/snapshot`,
          headers: { authorization: `Bearer ${viewer.token}` } })
        expect(response.statusCode, response.body).toBe(200)
        raw = response.json()
      } else {
        const result = await client.callTool({ name: 'run_board_snapshot_get', arguments: args })
        expect(result.isError).not.toBe(true)
        raw = decodeMcpToolResult(result)
      }
      expect(interleaved).toBe(true)
      const board = RunBoardSnapshotGetResultSchema.parse(raw)
      expect(board.intervalChecks).toEqual([
        { nodeId: watcher.id, everySeconds: 10, checks: 1, running: true, nextCheckAt: null },
      ])
      const persisted = (await runtime.db.pool.query('select execution_state from runs where id=$1', [f.run.id])).rows[0]
      expect(persisted).toEqual({ execution_state: 'completed' })
    } finally {
      snapshot.mockRestore()
      checkGate.resolve()
      workerGate.resolve()
      await runtime.stop()
      await runtime.engine.cancel(f.run.id)
      if (finished) await Promise.allSettled([finished])
      await Promise.allSettled(clients.map(client => client.close()))
      await app.close()
      await runtime.close()
    }
  }, 90_000)
})
