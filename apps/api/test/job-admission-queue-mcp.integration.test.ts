import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { JobPendingAdmissionSchema, JobQueueTicketSchema, JobQueuePageSchema, JobLaunchValidationSchema } from '@foreman-code/contracts/job-admission'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { DomainError } from '../src/modules/errors.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { ScheduleOperatorCapabilitiesSchema } from '../src/mcp/operator/tools/workflowSchedules.js'
import { setupJobAdmissionQueue } from './helpers/jobAdmissionQueue.js'

describe.skipIf(!postgresEnabled)('durable build admission queue: mcp', () => {
  const queue = setupJobAdmissionQueue()
  const { services, apps, clients, fixture, admissionTicketId, command, ordered } = queue

  it('persists source capacity waiting through authenticated MCP and resumes the original attempt', async () => {
    const { access, writer, reader } = queue
    let now = new Date()
    const f = await fixture({ clock: () => now })
    const definition = await f.save()
    const input = command(definition)
    f.accept.mockRejectedValueOnce(new DomainError('SOURCE_CAPACITY', 'Source storage is full', 409))
    const startApp = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access,
      services: { jobs: f.jobs, commands: f.commands } as unknown as OperatorServices } })
    apps.push(startApp)
    const startAddress = await startApp.listen({ host: '127.0.0.1', port: 0 })
    const starter = new Client({ name: 'source-capacity-starter', version: '1' })
    clients.push(starter)
    await starter.connect(new StreamableHTTPClientTransport(new URL('/mcp', startAddress),
      { requestInit: { headers: { authorization: `Bearer ${writer.token}` } } }))
    const started = await starter.callTool({ name: 'job_start', arguments: { workspaceId: f.workspaceId, ...input } })
    expect(started.isError).not.toBe(true)
    const admission = JobPendingAdmissionSchema.parse(
      (decodeMcpToolResult(started) as { admission: unknown }).admission)
    const id = admission.ticket.id
    f.online()
    await f.jobs.wakeQueue()
    const waiting = await f.jobs.getQueueTicket(reader.principal, f.workspaceId, id)
    expect(waiting).toMatchObject({ state: 'waiting', waitingReasons: ['busy'],
      sourceCapacityWait: { attempts: 1, waitedMs: 0 } })
    expect(waiting.reservationId).toBe(id)
    await f.jobs.closeQueue()
    const restarted = f.createService()
    services.push(restarted)
    await restarted.wakeQueue()
    expect(f.accept).toHaveBeenCalledTimes(1)
    const scopedReader = await access.issue({ name: 'Capacity reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 300000), grants: [{
        actions: ['jobs:read', 'capabilities:read'], scope: { workspaceIds: [f.workspaceId] },
      }] })
    const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access,
      services: { jobs: restarted, commands: f.commands } as unknown as OperatorServices } })
    apps.push(app)
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const client = new Client({ name: 'source-capacity-reader', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
      { requestInit: { headers: { authorization: `Bearer ${scopedReader.token}` } } }))
    const read = await client.callTool({ name: 'job_queue_get', arguments: { workspaceId: f.workspaceId, ticketId: id } })
    expect(JobQueueTicketSchema.parse((decodeMcpToolResult(read) as { ticket: unknown }).ticket)).toEqual(waiting)
    const denied = await client.callTool({ name: 'job_queue_get', arguments: { workspaceId: 'foreign-workspace', ticketId: id } })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    const deniedStart = await client.callTool({ name: 'job_start', arguments: { workspaceId: f.workspaceId, ...input } })
    expect(deniedStart.isError).toBe(true)
    now = new Date(Date.parse(waiting.sourceCapacityWait!.retryAt))
    await restarted.wakeQueue()
    const accepted = await restarted.getQueueTicket(reader.principal, f.workspaceId, id)
    expect(accepted).toMatchObject({ state: 'accepted', executionId: waiting.executionId,
      operationId: waiting.operationId, attemptId: waiting.attemptId, reservationId: id })
    expect(accepted.sourceCapacityWait).toBeUndefined()
    expect(f.accept).toHaveBeenCalledTimes(2)
    const acceptedRead = await client.callTool({ name: 'job_queue_get',
      arguments: { workspaceId: f.workspaceId, ticketId: id } })
    expect(JobQueueTicketSchema.parse((decodeMcpToolResult(acceptedRead) as { ticket: unknown }).ticket)).toEqual(accepted)
  })
  it('persists Agent CI origin separately from graph membership and reads it through authenticated MCP', async () => {
    const { access, writer } = queue
    const f = await fixture()
    const scopedReader = await access.issue({ name: 'CI origin reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 300000), grants: [{
        actions: ['jobs:read', 'capabilities:read'], scope: { workspaceIds: [f.workspaceId] },
      }] })
    const definition = await f.save()
    const input = command(definition)
    const initiatingAgent = { workflowId: 'workflow-origin', runId: 'run-origin',
      agentId: 'agent-origin', executionId: 'execution-origin' }
    const admission = await f.jobs.enqueue(f.principal, 'mcp', f.workspaceId, input, { initiatingAgent })
    const id = admissionTicketId(admission)
    await expect(f.jobs.enqueue(f.principal, 'mcp', f.workspaceId, input,
      { initiatingAgent: { ...initiatingAgent, executionId: 'another-execution' } }))
      .rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
    f.online()
    await f.jobs.wakeQueue()
    await f.jobs.closeQueue()
    const restarted = f.createService()
    services.push(restarted)
    const ticket = await restarted.getQueueTicket(scopedReader.principal, f.workspaceId, id)
    expect(ticket).toMatchObject({ state: 'accepted', workflow: null, initiatingAgent })
    const execution = await restarted.getExecution(scopedReader.principal, f.workspaceId, ticket.executionId)
    expect(execution).toMatchObject({ workflow: null, initiatingAgent })
    const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { jobs: restarted, commands: f.commands } as unknown as OperatorServices } })
    apps.push(app)
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const client = new Client({ name: 'ci-origin-tests', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
      { requestInit: { headers: { authorization: `Bearer ${scopedReader.token}` } } }))
    const listed = await client.callTool({ name: 'job_queue_list', arguments: {
      workspaceId: f.workspaceId, initiatingExecutionId: initiatingAgent.executionId,
    } })
    expect(JobQueuePageSchema.parse(decodeMcpToolResult(listed)).tickets).toEqual([ticket])
    const unrelated = await client.callTool({ name: 'job_queue_list', arguments: {
      workspaceId: f.workspaceId, initiatingExecutionId: 'another-execution',
    } })
    expect(JobQueuePageSchema.parse(decodeMcpToolResult(unrelated)).tickets).toEqual([])
    const read = await client.callTool({ name: 'job_get', arguments: {
      workspaceId: f.workspaceId, executionId: execution.id,
    } })
    expect(decodeMcpToolResult(read)).toEqual({ execution })
    const denied = await client.callTool({ name: 'job_queue_list', arguments: {
      workspaceId: 'foreign-workspace', initiatingExecutionId: initiatingAgent.executionId,
    } })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    const writerClient = new Client({ name: 'ci-origin-writer-tests', version: '1' })
    clients.push(writerClient)
    await writerClient.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
      { requestInit: { headers: { authorization: `Bearer ${writer.token}` } } }))
    expect((await writerClient.listTools()).tools.map(tool => tool.name)).toContain('job_start')
    const forged = await writerClient.callTool({ name: 'job_start', arguments: {
      workspaceId: f.workspaceId, ...input, commandId: randomUUID(), initiatingAgent,
    } })
    expect(forged.isError).not.toBe(true)
    const standalone = JobPendingAdmissionSchema.parse(
      (decodeMcpToolResult(forged) as { admission: unknown }).admission)
    const standaloneRead = await client.callTool({ name: 'job_queue_get', arguments: {
      workspaceId: f.workspaceId, ticketId: standalone.ticket.id,
    } })
    const standaloneTicket = JobQueueTicketSchema.parse(
      (decodeMcpToolResult(standaloneRead) as { ticket: unknown }).ticket)
    expect(standaloneTicket.workflow).toBeNull()
    expect(standaloneTicket.initiatingAgent).toBeUndefined()
    const originTickets = await client.callTool({ name: 'job_queue_list', arguments: {
      workspaceId: f.workspaceId, initiatingExecutionId: initiatingAgent.executionId,
    } })
    expect(JobQueuePageSchema.parse(decodeMcpToolResult(originTickets)).tickets).toEqual([ticket])
    expect((await client.callTool({ name: 'job_start', arguments: {
      workspaceId: f.workspaceId, ...input, commandId: randomUUID(),
    } })).isError).toBe(true)
    await f.complete(execution.id)
    await restarted.wakeQueue()
    const completed = await restarted.getQueueTicket(scopedReader.principal, f.workspaceId, id)
    expect(completed).toMatchObject({ state: 'terminal', terminalReason: 'completed', cleanupStatus: 'complete',
      executionId: execution.id, definition: ticket.definition, reservationId: ticket.reservationId })
    const terminalRead = await client.callTool({ name: 'job_queue_get', arguments: {
      workspaceId: f.workspaceId, ticketId: id,
    } })
    expect(decodeMcpToolResult(terminalRead)).toEqual({ ticket: completed })
    expect(await restarted.getAdmission(scopedReader.principal, f.workspaceId, id))
      .toEqual({ kind: 'accepted', ticketId: id, executionId: execution.id })
    expect((await restarted.getExecution(scopedReader.principal, f.workspaceId, execution.id)).acceptedSpec)
      .toEqual(execution.acceptedSpec)
    const deniedTerminal = await client.callTool({ name: 'job_queue_get', arguments: {
      workspaceId: 'foreign-workspace', ticketId: id,
    } })
    expect(deniedTerminal.isError).toBe(true)
  }, 60000)
  it('exposes the same persisted queue via authenticated HTTP/MCP and denies read-only and foreign-workspace writes', async () => {
    const { database, access, writer, reader } = queue
    const f = await fixture()
    const definition = await f.save()
    const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { jobs: f.jobs, commands: f.commands } as unknown as OperatorServices } })
    apps.push(app)
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    async function connect(token: string) {
      const client = new Client({ name: 'queue-tests', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
        { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
      return client
    }
    const client = await connect(writer.token)
    const readOnly = await connect(reader.token)
    const tools = (await client.listTools()).tools.map(tool => tool.name)
    expect(tools).toEqual(expect.arrayContaining(['job_queue_get', 'job_queue_list', 'job_queue_cancel']))
    const readerTools = (await readOnly.listTools()).tools.map(tool => tool.name)
    expect(readerTools).toEqual(expect.arrayContaining(['job_queue_get', 'job_queue_list']))
    expect(readerTools).not.toContain('job_queue_cancel')
    const capabilities = await client.callTool({ name: 'operator_get_capabilities', arguments: { detail: 'full',
      workspaceId: f.workspaceId,
    } })
    expect(capabilities.isError).not.toBe(true)
    const capabilitySummary = ScheduleOperatorCapabilitiesSchema.parse(decodeMcpToolResult(capabilities))
    expect(capabilitySummary.requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'job_queue_get', actions: ['jobs:read'] }),
      expect.objectContaining({ name: 'job_queue_list', actions: ['jobs:read'] }),
      expect.objectContaining({ name: 'job_queue_cancel', actions: ['jobs:cancel'] }),
    ]))
    const input = { workspaceId: f.workspaceId, ...command(definition) }
    const launch = { workspaceId: f.workspaceId, definitionId: definition.id, expectedRevision: definition.revision }
    expect(tools).toContain('job_launch_validate')
    expect(readerTools).not.toContain('job_launch_validate')
    const checked = await client.callTool({ name: 'job_launch_validate', arguments: launch })
    expect(checked.isError).not.toBe(true)
    expect(JobLaunchValidationSchema.parse(decodeMcpToolResult(checked)))
      .toMatchObject({ valid: false, canQueue: true, reasons: ['offline'] })
    expect((await readOnly.callTool({ name: 'job_launch_validate', arguments: launch })).isError).toBe(true)
    expect(await ordered(f)).toHaveLength(0)
    const httpCheck = await app.inject({ method: 'POST',
      url: `/api/management/workspaces/${f.workspaceId}/jobs/launch/validate`,
      headers: { authorization: `Bearer ${writer.token}` },
      payload: { definitionId: definition.id, expectedRevision: definition.revision } })
    expect(httpCheck.statusCode).toBe(200)
    expect(httpCheck.json()).toEqual(decodeMcpToolResult(checked))
    const denied = await readOnly.callTool({ name: 'job_start', arguments: input })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    expect(await ordered(f)).toHaveLength(0)
    const started = await client.callTool({ name: 'job_start', arguments: input })
    expect(started.isError).not.toBe(true)
    const { admission } = z.object({ admission: JobPendingAdmissionSchema }).parse(decodeMcpToolResult(started))
    expect(admission.kind).toBe('pending-admission')
    await f.jobs.wakeQueue()
    const retried = await client.callTool({ name: 'job_start', arguments: input })
    expect(retried.isError).not.toBe(true)
    const retry = z.object({ admission: JobPendingAdmissionSchema }).parse(decodeMcpToolResult(retried))
    expect(retry.admission.ticket.id).toBe(admission.ticket.id)
    await f.jobs.wakeQueue()
    const read = await readOnly.callTool({ name: 'job_queue_get', arguments: {
      workspaceId: f.workspaceId, ticketId: admission.ticket.id,
    } })
    expect(read.isError).not.toBe(true)
    const persisted = await f.jobs.getQueueTicket(reader.principal, f.workspaceId, admission.ticket.id)
    expect(decodeMcpToolResult(read)).toEqual({ ticket: persisted })
    const http = await app.inject({ method: 'GET',
      url: `/api/management/workspaces/${f.workspaceId}/jobs/queue/${persisted.id}`,
      headers: { authorization: `Bearer ${reader.token}` } })
    expect(http.statusCode).toBe(200)
    expect(http.json()).toEqual(decodeMcpToolResult(read))
    const listed = await readOnly.callTool({ name: 'job_queue_list', arguments: { workspaceId: f.workspaceId } })
    const httpList = await app.inject({ method: 'GET',
      url: `/api/management/workspaces/${f.workspaceId}/jobs/queue`,
      headers: { authorization: `Bearer ${reader.token}` } })
    expect(httpList.statusCode).toBe(200)
    expect(httpList.json()).toEqual(decodeMcpToolResult(listed))
    const { workspaceId, ...body } = input
    const crossTransport = await app.inject({ method: 'POST',
      url: `/api/management/workspaces/${workspaceId}/jobs/executions`,
      headers: { authorization: `Bearer ${writer.token}` }, payload: body })
    expect(crossTransport.statusCode).toBe(200)
    expect(crossTransport.json().admission).toMatchObject({ kind: 'pending-admission', ticket: { id: persisted.id } })
    const deniedHttp = await app.inject({ method: 'POST',
      url: `/api/management/workspaces/${workspaceId}/jobs/executions`,
      headers: { authorization: `Bearer ${reader.token}` }, payload: { ...body, commandId: randomUUID() } })
    expect(deniedHttp.statusCode).toBe(403)
    expect(deniedHttp.json().error.code).toBe('ACCESS_DENIED')
    const overrideInput = { ...input, commandId: randomUUID(),
      placementOverride: { kind: 'explicit', target: f.computers[0]!.candidate.spec.target } }
    const overrideCheck = await client.callTool({ name: 'job_launch_validate', arguments: {
      ...launch, placementOverride: overrideInput.placementOverride,
    } })
    expect(overrideCheck.isError).not.toBe(true)
    expect(JobLaunchValidationSchema.parse(decodeMcpToolResult(overrideCheck)))
      .toMatchObject({ valid: false, canQueue: true })
    expect((await readOnly.callTool({ name: 'job_start', arguments: overrideInput })).isError).toBe(true)
    const override = await client.callTool({ name: 'job_start', arguments: overrideInput })
    expect(override.isError).not.toBe(true)
    const overrideAdmission = z.object({ admission: JobPendingAdmissionSchema }).parse(decodeMcpToolResult(override))
    expect(decodeMcpToolResult((await client.callTool({ name: 'job_start', arguments: overrideInput }))))
      .toMatchObject({ admission: { ticket: { id: overrideAdmission.admission.ticket.id } } })
    await f.jobs.wakeQueue()
    const overrideTicket = await f.jobs.getQueueTicket(reader.principal, f.workspaceId, overrideAdmission.admission.ticket.id)
    expect(overrideTicket).toMatchObject({ placement: overrideInput.placementOverride,
      placementOverride: overrideInput.placementOverride, definition })
    const overrideRead = await readOnly.callTool({ name: 'job_queue_get', arguments: {
      workspaceId: f.workspaceId, ticketId: overrideTicket.id,
    } })
    expect(decodeMcpToolResult(overrideRead)).toEqual({ ticket: overrideTicket })
    await f.jobs.cancelQueued(writer.principal, 'mcp', f.workspaceId, { commandId: randomUUID(),
      ticketId: overrideTicket.id, expectedRevision: overrideTicket.revision })
    const cancellationTicket = await f.jobs.getQueueTicket(reader.principal, f.workspaceId, persisted.id)
    const cancelInput = { workspaceId: f.workspaceId, commandId: randomUUID(), ticketId: persisted.id,
      expectedRevision: cancellationTicket.revision }
    expect((await readOnly.callTool({ name: 'job_queue_cancel', arguments: cancelInput })).isError).toBe(true)
    const foreign = await access.issue({ name: 'Other workspace', audience: 'operator',
      expiresAt: new Date(Date.now() + 300000), grants: [{ actions: ['jobs:read', 'jobs:start', 'jobs:cancel'],
        scope: { workspaceIds: [randomUUID()] } }] })
    const foreignClient = await connect(foreign.token)
    expect((await foreignClient.callTool({ name: 'job_queue_get', arguments: {
      workspaceId: f.workspaceId, ticketId: persisted.id,
    } })).isError).toBe(true)
    expect((await foreignClient.callTool({ name: 'job_queue_list', arguments: { workspaceId: f.workspaceId } })).isError).toBe(true)
    expect((await foreignClient.callTool({ name: 'job_start', arguments: { ...input, commandId: randomUUID() } })).isError).toBe(true)
    expect((await foreignClient.callTool({ name: 'job_queue_cancel', arguments: cancelInput })).isError).toBe(true)
    const noGrants = await access.issue({ name: 'No Job grants', audience: 'operator',
      expiresAt: new Date(Date.now() + 300000), grants: [{ actions: ['capabilities:read'], scope: {} }] })
    const hidden = await connect(noGrants.token)
    for (const name of ['job_queue_get', 'job_queue_list', 'job_queue_cancel']) {
      const denied = await hidden.callTool({ name, arguments: cancelInput })
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
      expect((await database.pool.query(`select 1 from management_audit
        where principal_id=$1 and action=$2 and outcome='denied'`, [noGrants.principal.id, name])).rows.length).toBeGreaterThan(0)
    }
    const deniedCancel = await app.inject({ method: 'POST',
      url: `/api/management/workspaces/${workspaceId}/jobs/queue/${persisted.id}/cancel`,
      headers: { authorization: `Bearer ${reader.token}` },
      payload: { commandId: randomUUID(), expectedRevision: cancelInput.expectedRevision } })
    expect(deniedCancel.statusCode).toBe(403)
    const staleCancel = await client.callTool({ name: 'job_queue_cancel', arguments: {
      ...cancelInput, commandId: randomUUID(), expectedRevision: cancelInput.expectedRevision + 1,
    } })
    expect(staleCancel.isError).toBe(true)
    expect(JSON.stringify(staleCancel.content)).toContain('REVISION_CONFLICT')
    const cancelled = await client.callTool({ name: 'job_queue_cancel', arguments: cancelInput })
    expect(cancelled.isError).not.toBe(true)
    const cancellation = z.object({ ticket: JobQueueTicketSchema }).parse(decodeMcpToolResult(cancelled))
    expect(cancellation.ticket).toMatchObject({ state: 'terminal', terminalReason: 'cancelled' })
    const cancelledHttp = await app.inject({ method: 'POST',
      url: `/api/management/workspaces/${workspaceId}/jobs/queue/${persisted.id}/cancel`,
      headers: { authorization: `Bearer ${writer.token}` },
      payload: { commandId: cancelInput.commandId, expectedRevision: cancelInput.expectedRevision } })
    expect(cancelledHttp.statusCode).toBe(200)
    expect(cancelledHttp.json()).toEqual(decodeMcpToolResult(cancelled))
    expect(decodeMcpToolResult((await readOnly.callTool({ name: 'job_queue_get', arguments: {
      workspaceId, ticketId: persisted.id,
    } })))).toEqual(decodeMcpToolResult(cancelled))
    expect(f.accept).not.toHaveBeenCalled()
    const next = await client.callTool({ name: 'job_start', arguments: { ...input, commandId: randomUUID() } })
    expect(next.isError).not.toBe(true)
    const nextTicket = z.object({ admission: JobPendingAdmissionSchema }).parse(decodeMcpToolResult(next)).admission.ticket
    f.online()
    await f.jobs.wakeQueue()
    const executed = await readOnly.callTool({ name: 'job_get', arguments: {
      workspaceId: f.workspaceId, executionId: nextTicket.executionId,
    } })
    expect(executed.isError).not.toBe(true)
    expect(decodeMcpToolResult(executed)).toEqual({
      execution: await f.jobs.getExecution(reader.principal, f.workspaceId, nextTicket.executionId),
    })
    expect(f.accept).toHaveBeenCalledTimes(1)
    const acceptedRetry = await client.callTool({ name: 'job_start', arguments: {
      ...input, commandId: nextTicket.commandId,
    } })
    expect(decodeMcpToolResult(acceptedRetry)).toEqual({ admission: {
      kind: 'accepted', ticketId: nextTicket.id, executionId: nextTicket.executionId,
    } })
    expect(f.accept).toHaveBeenCalledTimes(1)
  }, 60000)
})
