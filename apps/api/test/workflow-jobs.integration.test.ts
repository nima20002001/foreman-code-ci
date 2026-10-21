import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { HarnessExecution } from '@foreman-code/contracts'
import { WorkflowJobPageSchema, type JobDefinitionRecord, type JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import { JobAdmissionResultSchema, JobQueuePageSchema, JobQueueTicketSchema } from '@foreman-code/contracts/job-admission'
import { JobWorkflowExecutionReferenceSchema, type JobWorkflowExecutionReference } from '@foreman-code/contracts/job-workflow'
import { AcceptedWorkflowRunV3Schema } from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'
import { buildQueueFixture } from './helpers/buildComputerFixture.js'
import { workHandoffFixture } from './helpers/workHandoffFixture.js'

// Accepted Jobs are fixture data; reads use the authenticated application and real PostgreSQL.
describe.skipIf(!postgresEnabled)('workflow job history HTTP and Operator MCP', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  let workflow: Awaited<ReturnType<typeof workHandoffFixture>>
  let queue: Awaited<ReturnType<typeof buildQueueFixture>>
  let access: PostgresAccessService
  let app: ReturnType<typeof buildApp>
  let address: string
  let reader: Awaited<ReturnType<PostgresAccessService['issue']>>
  let writer: Awaited<ReturnType<PostgresAccessService['issue']>>
  let denied: Awaited<ReturnType<PostgresAccessService['issue']>>
  let executions: JobExecutionRecord[]
  let agentExecution: HarnessExecution
  let queuedDefinition: JobDefinitionRecord
  let jobReference: JobWorkflowExecutionReference
  let queueNow: Date
  const clients: Client[] = []
  const path = () => `/api/management/workspaces/${workflow.run.workspaceId}/jobs/workflows/${workflow.run.workflowId}/executions`
  const headers = () => ({ authorization: `Bearer ${reader.token}` })
  async function connect(token: string) {
    const client = new Client({ name: 'workflow-history-test', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }))
    return client
  }
  const input = () => ({ workspaceId: workflow.run.workspaceId, workflowId: workflow.run.workflowId })
  beforeAll(async () => {
    database = await agent3Database()
    workflow = await workHandoffFixture(database.pool, randomUUID(), version => ({ ...version,
      definition: { ...version.definition, handoffs: { contractVersion: 1 } } }))
    agentExecution = (await workflow.queue(await workflow.store.ensureWorkEntry())).execution
    access = new PostgresAccessService(database.pool)
    writer = await access.issue({ name: 'Job author', audience: 'operator',
      expiresAt: new Date(Date.now() + 3600000), grants: [{ scope: {},
        actions: ['job_definitions:read', 'job_definitions:write', 'jobs:start', 'jobs:read', 'jobs:cancel', 'settings:read', 'settings:update'] }] })
    const acceptedRun = AcceptedWorkflowRunV3Schema.parse({ ...workflow.run,
      authorizationPrincipalId: writer.principal.id,
      executionLocation: { runnerId: 'fixture-runner', rootPath: '/synthetic/workflow-jobs',
        locationRevision: 1, identityHash: `sha256:${'a'.repeat(64)}` },
    })
    await database.pool.query('update runs set record=$2::jsonb where id=$1',
      [acceptedRun.id, JSON.stringify(acceptedRun)])
    reader = await access.issue({ name: 'Workflow history reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 3600000), grants: [{ actions: ['jobs:read', 'job_logs:read', 'job_artifacts:read', 'capabilities:read'],
        scope: { workspaceIds: [workflow.run.workspaceId], workflowIds: [workflow.run.workflowId] } }] })
    denied = await access.issue({ name: 'Other workflow reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 3600000), grants: [{ actions: ['jobs:read', 'job_logs:read', 'job_artifacts:read', 'capabilities:read'],
        scope: { workspaceIds: [workflow.run.workspaceId], workflowIds: ['foreign'] } }] })
    queueNow = new Date()
    queue = await buildQueueFixture(database.pool, writer.principal, {
      workspaceId: workflow.run.workspaceId, clock: () => queueNow,
    })
    queue.online()
    const definition = await queue.save(queue.computers[0]!.candidate.spec)
    const admission = JobAdmissionResultSchema.parse(await queue.jobs.enqueue(writer.principal, 'http',
      workflow.run.workspaceId, { commandId: randomUUID(), definitionId: definition.id, expectedRevision: 1 }))
    if (admission.kind === 'retained-execution') throw new Error('Fresh command reused a legacy execution')
    await queue.jobs.wakeQueue()
    const ticketId = admission.kind === 'accepted' ? admission.ticketId : admission.ticket.id
    const ticket = await queue.jobs.getQueueTicket(writer.principal, workflow.run.workspaceId, ticketId)
    await queue.complete(ticket.executionId)
    const original = await queue.jobs.getExecution(writer.principal, workflow.run.workspaceId, ticket.executionId)
    // Same-time executions exercise the cursor tie-breaker and both provenance paths.
    executions = Array.from({ length: 52 }, (_, index) => {
      const value = { ...original, id: `history-${String(index).padStart(3, '0')}`,
        operationId: randomUUID(), attemptId: randomUUID(), createdAt: '2026-10-01T00:00:00Z' }
      if (index % 2 === 0) return { ...value, workflow: {
        workflowId: workflow.run.workflowId, runId: workflow.run.id, nodeId: 'job-node', nodeExecutionId: `node-${index}`,
      } }
      return { ...value, initiatingAgent: { workflowId: workflow.run.workflowId, runId: workflow.run.id,
        agentId: 'agent-a', executionId: `agent-${index}` } }
    })
    const unrelated: JobExecutionRecord[] = [
      { ...original, id: 'orphan-run', operationId: randomUUID(), attemptId: randomUUID(),
        initiatingAgent: { workflowId: workflow.run.workflowId, runId: 'missing-run',
          agentId: 'agent-a', executionId: 'foreign-agent-exec' } },
      { ...original, id: 'foreign-workflow', operationId: randomUUID(), attemptId: randomUUID(),
        workflow: { workflowId: 'foreign', runId: workflow.run.id, nodeId: 'job-node', nodeExecutionId: 'foreign-node' } },
    ]
    for (const value of [...executions, ...unrelated]) {
      await database.pool.query(`insert into job_executions
        (id,workspace_id,definition_version_id,operation_id,attempt_id,record,accepted_spec,accepted_by)
        values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`, [value.id, value.workspaceId,
        value.acceptedSpec.definitionVersionId, value.operationId, value.attemptId, JSON.stringify(value),
        JSON.stringify(value.acceptedSpec), writer.principal.id])
    }
    const nodeJob = executions[0]!
    jobReference = JobWorkflowExecutionReferenceSchema.parse({ kind: 'job', ...input(),
      runId: workflow.run.id, workflowVersionId: workflow.run.workflowVersionId,
      nodeId: nodeJob.workflow!.nodeId, nodeExecutionId: nodeJob.workflow!.nodeExecutionId,
      jobExecutionId: nodeJob.id, occurrenceId: null, occurrenceIndex: 0 })
    await database.pool.query(`insert into workflow_job_executions
      (run_id,node_execution_id,job_execution_id,reference,input_json) values($1,$2,$3,$4::jsonb,'null')`,
    [workflow.run.id, jobReference.nodeExecutionId, nodeJob.id, JSON.stringify(jobReference)])
    queuedDefinition = await queue.jobs.saveDefinition(writer.principal, 'http', workflow.run.workspaceId, {
      commandId: randomUUID(), id: definition.id, expectedRevision: 1,
      name: 'Renamed after execution', spec: definition.spec,
    })
    app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { jobs: queue.jobs, commands: queue.commands,
        workflows: new WorkflowManagementService(database.pool, queue.commands) } as unknown as OperatorServices } })
    address = await app.listen({ host: '127.0.0.1', port: 0 })
  }, 60000)
  afterAll(async () => {
    await Promise.allSettled(clients.map(client => client.close()))
    await app?.close()
    await queue?.jobs.closeQueue()
    await workflow?.close()
    await database?.close()
  })

  it('reads both provenance paths, immutable names and every page in newest order', async () => {
    const firstHttp = await app.inject({ method: 'GET', url: path(), headers: headers() })
    expect(firstHttp.statusCode).toBe(200)
    const first = WorkflowJobPageSchema.parse(firstHttp.json())
    expect(first.items).toHaveLength(50)
    expect(first.items.every(item => item.name === 'Queued build')).toBe(true)
    expect(first.items.some(item => item.execution.workflow)).toBe(true)
    expect(first.items.some(item => item.execution.initiatingAgent)).toBe(true)
    const client = await connect(reader.token)
    const tools = await client.listTools()
    expect(tools.tools.some(tool => tool.name === 'job_workflow_list')).toBe(true)
    const firstMcp = await client.callTool({ name: 'job_workflow_list', arguments: input() })
    expect(firstMcp.isError).not.toBe(true)
    expect(decodeMcpToolResult(firstMcp)).toEqual(first)
    const second = await client.callTool({ name: 'job_workflow_list', arguments: { ...input(), cursor: first.nextCursor } })
    expect(second.isError).not.toBe(true)
    const last = WorkflowJobPageSchema.parse(decodeMcpToolResult(second))
    expect(last.items).toHaveLength(2)
    expect(last.nextCursor).toBeNull()
    const ids = [...first.items, ...last.items].map(item => item.execution.id)
    expect(ids).toEqual(executions.map(item => item.id).reverse())
    const persisted = await queue.jobs.repository.execution(database.pool, workflow.run.workspaceId, ids[0]!)
    expect(first.items[0]!.execution).toEqual(persisted)
    const lastHttp = await app.inject({ method: 'GET', headers: headers(),
      url: `${path()}?cursor=${encodeURIComponent(JSON.stringify(first.nextCursor))}` })
    expect(lastHttp.json()).toEqual(last)
  })

  it('returns empty history for a saved workflow without linked jobs', async () => {
    const emptyId = randomUUID()
    await database.pool.query('insert into workflows(id,workspace_id,record) values($1,$2,$3::jsonb)',
      [emptyId, workflow.run.workspaceId, JSON.stringify({ id: emptyId, workspaceId: workflow.run.workspaceId })])
    const client = await connect(writer.token)
    const result = await client.callTool({ name: 'job_workflow_list', arguments: { ...input(), workflowId: emptyId } })
    const expected = { ...input(), workflowId: emptyId, items: [], nextCursor: null }
    expect(decodeMcpToolResult(result)).toEqual(expected)
    const http = await app.inject({ method: 'GET',
      url: path().replace(workflow.run.workflowId, emptyId),
      headers: { authorization: `Bearer ${writer.token}` } })
    expect(http.statusCode).toBe(200)
    expect(http.json()).toEqual(expected)
  })

  it('opens node and Agent CI results with workflow-scoped grants over HTTP and MCP', async () => {
    const client = await connect(reader.token)
    const deniedClient = await connect(denied.token)
    for (const execution of executions.slice(0, 2)) {
      const arguments_ = { workspaceId: execution.workspaceId, executionId: execution.id }
      const root = `/api/management/workspaces/${execution.workspaceId}/jobs/executions/${execution.id}`
      const http = await app.inject({ method: 'GET', url: root, headers: headers() })
      expect(http.statusCode).toBe(200)
      expect(http.json()).toEqual({ execution })
      const mcp = await client.callTool({ name: 'job_get', arguments: arguments_ })
      expect(mcp.isError).not.toBe(true)
      expect(decodeMcpToolResult(mcp)).toEqual(http.json())
      for (const [suffix, tool] of [['/logs', 'job_logs_read'], ['/artifacts', 'job_artifacts_list']] as const) {
        const result = await app.inject({ method: 'GET', url: `${root}${suffix}`, headers: headers() })
        expect(result.statusCode).toBe(200)
        const read = await client.callTool({ name: tool, arguments: arguments_ })
        expect(read.isError).not.toBe(true)
        expect(decodeMcpToolResult(read)).toEqual(result.json())
      }
      for (const [suffix, tool] of [['', 'job_get'], ['/logs', 'job_logs_read'], ['/artifacts', 'job_artifacts_list']] as const) {
        const blocked = await app.inject({ method: 'GET', url: `${root}${suffix}`,
          headers: { authorization: `Bearer ${denied.token}` } })
        expect(blocked.statusCode).toBe(403)
        expect((await deniedClient.callTool({ name: tool, arguments: arguments_ })).isError).toBe(true)
      }
    }
    for (const executionId of ['orphan-run', 'foreign-workflow']) {
      const result = await client.callTool({ name: 'job_get',
        arguments: { workspaceId: workflow.run.workspaceId, executionId } })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('ACCESS_DENIED')
    }
  })

  it('denies other-workflow callers over HTTP and MCP and audits denial', async () => {
    const http = await app.inject({ method: 'GET', url: path(), headers: { authorization: `Bearer ${denied.token}` } })
    expect(http.statusCode).toBe(403)
    const client = await connect(denied.token)
    const result = await client.callTool({ name: 'job_workflow_list', arguments: input() })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('ACCESS_DENIED')
    const audits = await database.pool.query('select source from management_audit where principal_id=$1 and outcome=$2',
      [denied.principal.id, 'denied'])
    expect(audits.rows.map(row => row.source)).toEqual(expect.arrayContaining(['http', 'mcp']))
  })

  it('reads workflow-wide queued CI and retained preacceptance outcomes with scoped HTTP and MCP', async () => {
    queue.computers[0]!.candidate.ready = false
    queue.computers[0]!.candidate.reasons = ['offline']
    const origin = { workflowId: workflow.run.workflowId, runId: workflow.run.id,
      agentId: agentExecution.agentId, executionId: agentExecution.id }
    async function enqueue(initiatingAgent = origin) {
      const admission = await queue.jobs.enqueue(writer.principal, 'http', workflow.run.workspaceId,
        { commandId: randomUUID(), definitionId: queuedDefinition.id, expectedRevision: queuedDefinition.revision },
        { initiatingAgent })
      if (admission.kind === 'retained-execution') throw new Error('Fresh command reused an execution')
      const id = admission.kind === 'accepted' ? admission.ticketId : admission.ticket.id
      return queue.jobs.getQueueTicket(writer.principal, workflow.run.workspaceId, id)
    }
    const first = await enqueue()
    const second = await enqueue()
    const foreign = await enqueue({ ...origin, workflowId: 'foreign' })
    await queue.jobs.wakeQueue()
    const root = `/api/management/workspaces/${workflow.run.workspaceId}/jobs/queue`
    const client = await connect(reader.token)
    const tools = await client.listTools()
    expect(tools.tools.find(tool => tool.name === 'job_queue_list')?.inputSchema.properties)
      .toHaveProperty('workflowId')
    const waitingHttp = await app.inject({ method: 'GET', url: `${root}?workflowId=${workflow.run.workflowId}`,
      headers: headers() })
    expect(waitingHttp.statusCode).toBe(200)
    const waiting = JobQueuePageSchema.parse(waitingHttp.json())
    expect(waiting.tickets.map(ticket => ticket.id)).toEqual([first.id, second.id])
    expect(waiting.tickets.every(ticket => ticket.state === 'waiting')).toBe(true)
    expect(waiting.tickets.some(ticket => ticket.id === foreign.id)).toBe(false)
    const waitingMcp = await client.callTool({ name: 'job_queue_list', arguments: input() })
    expect(waitingMcp.isError).not.toBe(true)
    expect(decodeMcpToolResult(waitingMcp)).toEqual(waiting)
    const writerClient = await connect(writer.token)
    const cancelled = await writerClient.callTool({ name: 'job_queue_cancel', arguments: {
      workspaceId: workflow.run.workspaceId, ticketId: first.id, expectedRevision: waiting.tickets[0]!.revision,
      commandId: randomUUID(),
    } })
    expect(cancelled.isError).not.toBe(true)
    queueNow = new Date(Date.parse(second.deadlineAt) + 1)
    await queue.jobs.wakeQueue()
    const retained = await client.callTool({ name: 'job_queue_list', arguments: input() })
    expect(retained.isError).not.toBe(true)
    const page = JobQueuePageSchema.parse(decodeMcpToolResult(retained))
    expect(page.tickets.map(ticket => ticket.id)).toEqual([second.id, first.id])
    expect(page.tickets.map(ticket => ticket.terminalReason)).toEqual(['timed_out', 'cancelled'])
    for (const ticket of page.tickets) {
      const persisted = await queue.jobs.repository.queueTicket(database.pool, workflow.run.workspaceId, ticket.id)
      expect(ticket).toMatchObject(persisted)
      const http = await app.inject({ method: 'GET', url: `${root}/${ticket.id}`, headers: headers() })
      expect(http.statusCode).toBe(200)
      const read = await client.callTool({ name: 'job_queue_get', arguments: {
        workspaceId: workflow.run.workspaceId, ticketId: ticket.id,
      } })
      expect(read.isError).not.toBe(true)
      expect(JobQueueTicketSchema.parse((decodeMcpToolResult(read) as { ticket: unknown }).ticket)).toEqual(ticket)
      expect(decodeMcpToolResult(read)).toEqual(http.json())
    }
    const deniedClient = await connect(denied.token)
    expect((await app.inject({ method: 'GET', url: `${root}?workflowId=${workflow.run.workflowId}`,
      headers: { authorization: `Bearer ${denied.token}` } })).statusCode).toBe(403)
    const deniedRead = await deniedClient.callTool({ name: 'job_queue_list', arguments: input() })
    expect(deniedRead.isError).toBe(true)
    expect(JSON.stringify(deniedRead.content)).toContain('ACCESS_DENIED')
    const deniedCancel = await client.callTool({ name: 'job_queue_cancel', arguments: {
      workspaceId: workflow.run.workspaceId, ticketId: first.id, expectedRevision: first.revision,
      commandId: randomUUID(),
    } })
    expect(deniedCancel.isError).toBe(true)
    expect(JSON.stringify(deniedCancel.content)).toContain('ACCESS_DENIED')
  })

  it('authorizes Agent tickets and Job references by their persisted workflow and Run over HTTP and MCP', async () => {
    queue.computers[0]!.candidate.ready = false
    queue.computers[0]!.candidate.reasons = ['offline']
    const admission = await queue.jobs.enqueue(writer.principal, 'http', workflow.run.workspaceId,
      { commandId: randomUUID(), definitionId: queuedDefinition.id, expectedRevision: queuedDefinition.revision },
      { initiatingAgent: { workflowId: workflow.run.workflowId, runId: workflow.run.id,
        agentId: agentExecution.agentId, executionId: agentExecution.id } })
    if (admission.kind === 'retained-execution') throw new Error('Fresh command reused an execution')
    const ticketId = admission.kind === 'accepted' ? admission.ticketId : admission.ticket.id
    await queue.jobs.wakeQueue()
    const runReader = await access.issue({ name: 'One Run reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 300000), grants: [{ actions: ['jobs:read', 'capabilities:read'],
        scope: { workspaceIds: [workflow.run.workspaceId], runIds: [workflow.run.id] } }] })
    const otherRun = await access.issue({ name: 'Other Run reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 300000), grants: [{ actions: ['jobs:read', 'capabilities:read'],
        scope: { workspaceIds: [workflow.run.workspaceId], workflowIds: [workflow.run.workflowId],
          runIds: ['other-run'] } }] })
    const queueInput = { workspaceId: workflow.run.workspaceId, initiatingExecutionId: agentExecution.id }
    const referenceInput = { workspaceId: workflow.run.workspaceId, runId: workflow.run.id,
      nodeExecutionId: jobReference.nodeExecutionId }
    const root = `/api/management/workspaces/${workflow.run.workspaceId}/jobs`
    const referencePath = `${root}/workflow-executions/${workflow.run.id}/${jobReference.nodeExecutionId}`
    for (const token of [reader.token, runReader.token]) {
      const client = await connect(token)
      const headers = { authorization: `Bearer ${token}` }
      const queueHttp = await app.inject({ method: 'GET',
        url: `${root}/queue?initiatingExecutionId=${agentExecution.id}`, headers })
      expect(queueHttp.statusCode).toBe(200)
      const listed = await client.callTool({ name: 'job_queue_list', arguments: queueInput })
      expect(listed.isError).not.toBe(true)
      expect(decodeMcpToolResult(listed)).toEqual(queueHttp.json())
      const page = JobQueuePageSchema.parse(decodeMcpToolResult(listed))
      expect(page.tickets.some(ticket => ticket.id === ticketId)).toBe(true)
      for (const ticket of page.tickets) {
        const read = await client.callTool({ name: 'job_queue_get', arguments: {
          workspaceId: workflow.run.workspaceId, ticketId: ticket.id,
        } })
        expect(read.isError).not.toBe(true)
        expect((decodeMcpToolResult(read) as { ticket: unknown }).ticket).toEqual(ticket)
      }
      const referenceHttp = await app.inject({ method: 'GET', url: referencePath, headers })
      expect(referenceHttp.statusCode).toBe(200)
      const reference = await client.callTool({ name: 'job_workflow_execution_get', arguments: referenceInput })
      expect(reference.isError).not.toBe(true)
      expect(decodeMcpToolResult(reference)).toEqual({ reference: jobReference })
      expect(decodeMcpToolResult(reference)).toEqual(referenceHttp.json())
      const persisted = await database.pool.query<{ reference: unknown }>(
        'select reference from workflow_job_executions where run_id=$1 and node_execution_id=$2',
        [workflow.run.id, jobReference.nodeExecutionId])
      expect(decodeMcpToolResult(reference)).toEqual({ reference: persisted.rows[0]!.reference })
    }
    for (const token of [denied.token, otherRun.token]) {
      const client = await connect(token)
      const headers = { authorization: `Bearer ${token}` }
      for (const [tool, arguments_, url] of [
        ['job_queue_list', queueInput, `${root}/queue?initiatingExecutionId=${agentExecution.id}`],
        ['job_queue_get', { workspaceId: workflow.run.workspaceId, ticketId }, `${root}/queue/${ticketId}`],
        ['job_workflow_execution_get', referenceInput, referencePath],
      ] as const) {
        expect((await app.inject({ method: 'GET', url, headers })).statusCode).toBe(403)
        const blocked = await client.callTool({ name: tool, arguments: arguments_ })
        expect(blocked.isError).toBe(true)
        expect(JSON.stringify(blocked.content)).toContain('ACCESS_DENIED')
      }
    }
    const audits = await database.pool.query('select source from management_audit where principal_id=$1 and outcome=$2',
      [otherRun.principal.id, 'denied'])
    expect(audits.rows.map(row => row.source)).toEqual(expect.arrayContaining(['http', 'mcp']))
  })

  it('rechecks live grants on an existing authenticated MCP session', async () => {
    const client = await connect(reader.token)
    await database.pool.query("update management_principals set grants='[]'::jsonb where id=$1", [reader.principal.id])
    const result = await client.callTool({ name: 'job_workflow_list', arguments: input() })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('ACCESS_DENIED')
  })
})
