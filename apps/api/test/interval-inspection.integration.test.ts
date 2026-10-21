import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { describe, expect, it, vi } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import {
  RUN_INSPECTION_TOOLS, RunExecutionDetailSchema, RunExecutionBindingsPageSchema, RunExecutionsPageSchema,
} from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import { RepeatRunRepository } from '../src/modules/runs/repeatPostgres.js'
import { deferred } from './helpers/deferred.js'
import { intervalRuntime } from './helpers/intervalRuntime.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

describe.runIf(postgresEnabled)('interval execution inspection', () => {
  it('reads admitted queued, running and completed check inputs through HTTP and authenticated MCP', async () => {
    const { runtime, f, watcher, checkStarted, checkGate, workerGate } = await intervalRuntime()
    const queued = deferred<string>()
    const dispatch = deferred()
    const completed = deferred()
    let inspectedExecutionId: string | undefined
    const observe = runtime.native.observeExact.bind(runtime.native)
    const observation = vi.spyOn(runtime.native, 'observeExact').mockImplementation(async input => {
      const result = await observe(input)
      if (result.state === 'completed' && result.execution.id === inspectedExecutionId) completed.resolve()
      return result
    })
    const admit = RepeatRunRepository.prototype.admitTick
    const admission = vi.spyOn(RepeatRunRepository.prototype, 'admitTick').mockImplementation(async function (
      this: RepeatRunRepository, ...args
    ) {
      const result = await admit.apply(this, args)
      if (result.kind === 'admitted') {
        inspectedExecutionId = result.execution.id
        queued.resolve(result.execution.id)
        await dispatch.promise
      }
      return result
    })
    const commands = new PostgresCommandCoordinator(runtime.db.pool)
    type Args = ConstructorParameters<typeof RunManagementService>
    const runs = new RunManagementService(runtime.db.pool, commands, runtime.runs, runtime.engine, {} as Args[4])
    const app = buildApp({ operator: { access: runtime.access, services: { runs, commands } as unknown as OperatorServices },
      readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } } })
    const clients: Client[] = []
    let finished: Promise<unknown> | undefined
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const issue = async (runId: string) => {
        const reader = await runtime.access.issue({ name: 'Interval inspector', audience: 'operator',
          expiresAt: new Date(Date.now() + 300_000),
          grants: [{ actions: ['runs:read'], scope: { workspaceIds: [f.run.workspaceId], runIds: [runId] } }] })
        const client = new Client({ name: 'interval-inspector', version: '1' })
        clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
          authProvider: { token: async () => reader.token },
        }))
        return { client, token: reader.token }
      }
      const reader = await issue(f.run.id)
      const denied = await issue('another-run')
      finished = runtime.engine.start(f.run.id)
      const executionId = await queued.promise
      const args = { workspaceId: f.run.workspaceId, runId: f.run.id, executionId }
      const base = `/api/management/workspaces/${f.run.workspaceId}/runs/${f.run.id}/executions`
      const read = async (name: string, suffix: string, input: Record<string, unknown>) => {
        const http = await app.inject({ method: 'GET', url: `${base}${suffix}`,
          headers: { authorization: `Bearer ${reader.token}` } })
        expect(http.statusCode, http.body).toBe(200)
        const remote = await reader.client.callTool({ name, arguments: input })
        expect(remote.isError).not.toBe(true)
        expect(decodeMcpToolResult(remote)).toEqual(http.json())
        return http.json()
      }
      const stored = (await runtime.db.pool.query<{ input_json: string; input_digest: string }>(
        'select input_json,input_digest from run_repeat_slots where run_id=$1 and tick_index=1', [f.run.id])).rows[0]!
      const input = JSON.parse(stored.input_json)
      expect(input.tick).toEqual({ index: 1, everySeconds: 10 })
      for (const state of ['queued', 'running', 'completed']) {
        const detail = RunExecutionDetailSchema.parse(await read(RUN_INSPECTION_TOOLS.execution, `/${executionId}`, args))
        expect(detail.execution).toMatchObject({ state, tickIndex: 1, workflowNodeId: watcher.id })
        expect(detail.acceptedInput).toEqual({ digest: stored.input_digest, value: input })
        const bindings = RunExecutionBindingsPageSchema.parse(await read(
          RUN_INSPECTION_TOOLS.bindings, `/${executionId}/bindings`, args))
        expect(bindings).toMatchObject({ inputDigest: stored.input_digest, items: [], pageInfo: { nextCursor: null } })
        const page = RunExecutionsPageSchema.parse(await read(RUN_INSPECTION_TOOLS.executions, '', {
          workspaceId: f.run.workspaceId, runId: f.run.id,
        }))
        expect(page.items.find(item => item.executionId === executionId)).toMatchObject({
          state, tickIndex: 1, workflowNodeId: watcher.id,
        })
        if (state === 'queued') {
          dispatch.resolve()
          expect(await checkStarted.promise).toBe(executionId)
        } else if (state === 'running') {
          checkGate.resolve()
          workerGate.resolve()
          await completed.promise
          expect((await runtime.runs.getExecution(executionId))?.state).toBe('completed')
          await runtime.stop()
          await runtime.engine.cancel(f.run.id)
          await Promise.allSettled([finished])
        } else {
          const ordinary = page.items.find(item => item.workflowNodeId === watcher.id && item.tickIndex === undefined)
          expect(ordinary).toBeDefined()
          const ordinaryArgs = { ...args, executionId: ordinary!.executionId }
          const ordinaryDetail = RunExecutionDetailSchema.parse(await read(
            RUN_INSPECTION_TOOLS.execution, `/${ordinary!.executionId}`, ordinaryArgs,
          ))
          expect(ordinaryDetail.execution).not.toHaveProperty('tickIndex')
          expect(ordinaryDetail.acceptedInput.value).not.toHaveProperty('tick')
        }
      }
      const refused = await denied.client.callTool({ name: RUN_INSPECTION_TOOLS.execution, arguments: args })
      expect(refused.isError).toBe(true)
      const http = await app.inject({ method: 'GET', url: `${base}/${executionId}`,
        headers: { authorization: `Bearer ${denied.token}` } })
      expect(http.statusCode).toBe(403)
    } finally {
      dispatch.resolve()
      checkGate.resolve()
      workerGate.resolve()
      admission.mockRestore()
      observation.mockRestore()
      if (finished) {
        await runtime.stop()
        await runtime.engine.cancel(f.run.id)
        await Promise.allSettled([finished])
      }
      await Promise.allSettled(clients.map(client => client.close()))
      await app.close()
      await runtime.close()
    }
  }, 90_000)
})
