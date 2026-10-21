import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { AgentRunStatusSchema, CiRunRecordSchema, HarnessExecutionSchema } from '@foreman-code/contracts'
import { BugReportPageSchema, BugReportSchema } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { BugReportService } from '../src/modules/bug-reports/service.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresAppInteractionService } from '../src/modules/interactions/app.js'
import { workerToolServices } from './helpers/workerMcpServices.js'
import { intervalRuntime } from './helpers/intervalRuntime.js'
import { measuredCiPages } from './helpers/measuredCiPages.js'

it('reports an idle running execution after every CI ticket ends, without stopping it, through authenticated MCP',
  async () => {
    const { runtime, f, watcher, worker, checkStarted, checkGate, workerGate } = await intervalRuntime()
    const commands = new PostgresCommandCoordinator(runtime.db.pool)
    const tools = workerToolServices(runtime.db.pool, commands)
    const { bugReports: bugs, ci } = tools
    const app = buildApp({
      logger: false,
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access: runtime.access, services: { commands, ci, bugReports: bugs } as never },
      appMcp: tools.appMcp(runtime.access, new PostgresAppInteractionService(runtime.db.pool, runtime.repository, commands)),
    })
    const clients: Client[] = []
    let finished: Promise<unknown> | undefined
    try {
      finished = Promise.allSettled([runtime.engine.start(f.run.id)])
      const checkId = await checkStarted.promise
      const executionRow = (await runtime.db.pool.query<{ record: unknown }>(
        'select record from harness_executions where run_id=$1 and workflow_node_id=$2',
        [f.run.id, worker.id],
      )).rows[0]!
      const execution = HarnessExecutionSchema.parse(executionRow.record)
      expect(execution.state).toBe('running')
      const idleMs = 3_600_000
      const observedAt = new Date(Date.now() + 65 * 60_000)
      expect(await bugs.detectStuckExecutions(idleMs, observedAt)).toBe(0)

      // An older live ticket must prevent detection even beyond the status page's 20-ticket limit.
      const tickets = Array.from({ length: 24 }, (_, index) => CiRunRecordSchema.parse({
        id: randomUUID(), groupId: randomUUID(), workspaceId: f.scope.workspaceId,
        suite: 'unit', commit: 'a'.repeat(40), repository: 'example/project', partition: null,
        state: index === 0 ? 'queued' : ['passed', 'failed', 'lost', 'canceled'][index % 4],
        computer: null, step: null, exitCode: null, message: null,
        queuedAt: execution.createdAt, startedAt: null,
        finishedAt: index === 0 ? null : execution.createdAt,
        initiator: { principalId: f.run.authorizationPrincipalId, executionId: execution.id },
      }))
      for (const ticket of tickets) {
        await runtime.db.pool.query(`insert into ci_runs(id,workspace_id,group_id,state,record)
          values($1,$2,$3,$4,$5::jsonb)`,
        [ticket.id, ticket.workspaceId, ticket.groupId, ticket.state, JSON.stringify(ticket)])
      }
      expect(await bugs.detectStuckExecutions(idleMs, observedAt)).toBe(0)
      // Other executions' finished tickets accumulate in the workspace; detection reads only this execution's.
      const unrelated = await runtime.db.pool.query(`insert into ci_runs(id,workspace_id,group_id,state,record,log_tail)
        select u.id,t.workspace_id,u.id,'canceled',t.record||jsonb_build_object('id',u.id::text,'groupId',u.id::text,
            'state','canceled','initiator',t.record->'initiator'||jsonb_build_object('executionId','unrelated-'||u.id::text)),
          (select string_agg(md5(u.id::text||g::text),'') from generate_series(1,40) g)
        from ci_runs t cross join (select gen_random_uuid() as id from generate_series(1,3000)) u where t.id=$1`,
      [tickets[1]!.id])
      expect(unrelated.rowCount).toBe(3000)
      await runtime.db.pool.query('analyze ci_runs')
      const measured = measuredCiPages(runtime.db.pool)
      expect(await new BugReportService(measured.pool, commands).detectStuckExecutions(idleMs, observedAt)).toBe(0)
      // The unrelated tickets span hundreds of heap pages; this execution's 24 tickets need a handful.
      expect(measured.pages.max).toBeLessThan(100)
      await runtime.db.pool.query(`update ci_runs set state='running',record=record||'{"state":"running"}'::jsonb
        where id=$1`, [tickets[0]!.id])
      expect(await bugs.detectStuckExecutions(idleMs, observedAt)).toBe(0)
      await runtime.db.pool.query(`update ci_runs set state='canceled',record=record||jsonb_build_object(
        'state','canceled','finishedAt',$2::text) where id=$1`, [tickets[0]!.id, observedAt.toISOString()])
      expect(await bugs.detectStuckExecutions(idleMs, observedAt)).toBe(0)

      const later = new Date(observedAt.getTime() + idleMs + 60_000)
      // Streaming deltas are retained natively even when omitted from run_activity.
      await runtime.db.pool.query('select append_harness_native_event($1::jsonb)', [JSON.stringify({
        executionId: execution.id, connectionId: randomUUID(), sequence: 0, type: 'notification',
        occurredAt: later.toISOString(), payload: { nativeMethod: 'item/agentMessage/delta' },
      })])
      expect(await bugs.detectStuckExecutions(idleMs, later)).toBe(0)
      const detectionAt = new Date(later.getTime() + idleMs + 60_000)
      expect(await bugs.detectStuckExecutions(idleMs * 2, detectionAt)).toBe(0)
      const scans = await Promise.all([
        bugs.detectStuckExecutions(idleMs, detectionAt),
        bugs.detectStuckExecutions(idleMs, detectionAt),
      ])
      expect(scans.reduce((count, reported) => count + reported, 0)).toBe(1)
      const restarted = new BugReportService(runtime.db.pool, commands)
      expect(await restarted.detectStuckExecutions(idleMs, detectionAt)).toBe(0)

      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const connect = async (token: string) => {
        const client = new Client({ name: 'stuck-execution-test', version: '1' })
        clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }))
        return client
      }
      const reader = await runtime.access.issue({ name: 'Report reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 600_000),
        grants: [{ actions: ['bug_reports:read'], scope: { workspaceIds: [f.scope.workspaceId] } }],
      })
      const operator = await connect(reader.token)
      const listed = await operator.callTool({ name: 'bug_reports_list', arguments: { workspaceId: f.scope.workspaceId } })
      expect(listed.isError).not.toBe(true)
      const page = BugReportPageSchema.parse(decodeMcpToolResult(listed))
      expect(page.items).toHaveLength(1)
      const report = page.items[0]!
      expect(report).toMatchObject({ runId: f.run.id, workflowId: f.scope.workflowId,
        occurrenceCount: 1, happened: { errorCode: 'AGENT_EXECUTION_STUCK' } })
      const readback = await operator.callTool({ name: 'bug_report_get', arguments: { reportId: report.id } })
      expect(BugReportSchema.parse(decodeMcpToolResult(readback))).toEqual(report)
      const deniedCredential = await runtime.access.issue({ name: 'Other workspace reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 600_000),
        grants: [{ actions: ['bug_reports:read'], scope: { workspaceIds: ['other-workspace'] } }],
      })
      const denied = await connect(deniedCredential.token)
      const refused = await denied.callTool({ name: 'bug_report_get', arguments: { reportId: report.id } })
      expect(refused.isError).toBe(true)
      expect(JSON.stringify(refused.content)).not.toContain(execution.id)

      const credential = await runtime.credentials.issueForExecution(checkId)
      const checker = await connect(credential.environment.variables.GRAPHQL_MCP_TOKEN!)
      const catalog = await checker.listTools()
      expect(catalog.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
        'run_status_get', 'ci_run', 'ci_get', 'ci_computers_list', 'ci_cancel', 'ci_logs_read',
      ]))
      const result = await checker.callTool({ name: 'run_status_get', arguments: {} })
      expect(result.isError).not.toBe(true)
      const status = AgentRunStatusSchema.parse(decodeMcpToolResult(result))
      expect(status.errors).toContainEqual(expect.objectContaining({
        nodeId: worker.id, executionId: execution.id, code: 'AGENT_EXECUTION_STUCK',
      }))
      expect(status.nodes.find(node => node.nodeId === worker.id)?.state).toBe('running')
      expect(status.self.nodeId).toBe(watcher.id)
      expect(status.run.stopRequested).toBe(false)
      expect(HarnessExecutionSchema.parse((await runtime.db.pool.query<{ record: unknown }>(
        'select record from harness_executions where id=$1', [execution.id],
      )).rows[0]!.record)).toEqual(execution)
      await runtime.credentials.revoke(credential)
      checkGate.resolve()
      workerGate.resolve()
      await runtime.stop()
      await runtime.engine.cancel(f.run.id)
      await finished
      expect(await restarted.detectStuckExecutions(idleMs, detectionAt)).toBe(0)
    } finally {
      checkGate.resolve()
      workerGate.resolve()
      if (finished) {
        await runtime.stop()
        await runtime.engine.cancel(f.run.id)
        await finished
      }
      await Promise.allSettled(clients.map(client => client.close()))
      await app.close()
      await runtime.close()
    }
  }, 90_000,
)
