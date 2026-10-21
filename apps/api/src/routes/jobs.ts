import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { JobDefinitionSaveRecordSchema, JobDefinitionSpecRecordSchema, WorkflowJobListInputSchema } from '@foreman-code/contracts/job-verification'
import { JobQueuedStartSchema, JobQueueCancelSchema, JobQueueListInputSchema,
  JobLaunchValidationInputSchema } from '@foreman-code/contracts/job-admission'
import { DomainError } from '../modules/errors.js'
import { requirePrincipal } from '../modules/access/http.js'
import type { JobService } from '../modules/jobs/service.js'
import { JobCancelInputSchema, JobCancellationProposalInputSchema, JobCancellationRecoveryApproveSchema } from '@foreman-code/contracts/job-cancellation-recovery'
interface Scope {
  workspaceId: string; workflowId: string; runId: string; nodeExecutionId: string; definitionId: string; versionId: string;
  executionId: string; ticketId: string; fileId: string; revisionId: string; recoveryId: string
}
export function registerJobRoutes(app:FastifyInstance,service:JobService):void {
  const root='/api/management/workspaces/:workspaceId/jobs'
  app.get<{ Params: Scope; Querystring: Record<string, string> }>(`${root}/workflows/:workflowId/executions`,
    request => {
      const { limit, cursor, ...rest } = request.query
      let parsedCursor: unknown
      if (cursor !== undefined) {
        try {
          parsedCursor = JSON.parse(cursor)
        } catch {
          throw new DomainError('INVALID_REQUEST', 'The job history cursor is invalid.', 400)
        }
      }
      const input = WorkflowJobListInputSchema.parse({ ...rest,
        ...(limit === undefined ? {} : { limit: Number(limit) }),
        ...(cursor === undefined ? {} : { cursor: parsedCursor }),
      })
      return service.listWorkflowExecutions(requirePrincipal(request), request.params.workspaceId,
        request.params.workflowId, input)
    })
  app.get<{Params:Scope}>(`${root}/choices`,async request=>service.choices(requirePrincipal(request),request.params.workspaceId))
  app.get<{Params:Scope}>(`${root}/workflow-executions/:runId/:nodeExecutionId`,async request=>({reference:await service.getWorkflowExecutionReference(requirePrincipal(request),request.params.workspaceId,request.params.runId,request.params.nodeExecutionId)}))
  app.get<{Params:Scope}>(`${root}/definitions`,async request=>({definitions:await service.listDefinitions(requirePrincipal(request),request.params.workspaceId)}))
  app.get<{Params:Scope}>(`${root}/definitions/:definitionId`,async request=>({definition:await service.getDefinition(requirePrincipal(request),request.params.workspaceId,request.params.definitionId)}))
  app.get<{Params:Scope}>(`${root}/definitions/:definitionId/versions/:versionId`,async request=>({definition:await service.getDefinitionVersion(requirePrincipal(request),request.params.workspaceId,request.params.definitionId,request.params.versionId)}))
  app.post<{Params:Scope;Body:unknown}>(`${root}/definitions`,async request=>({definition:await service.saveDefinition(requirePrincipal(request),'http',request.params.workspaceId,JobDefinitionSaveRecordSchema.parse(request.body))}))
  app.post<{Params:Scope;Body:unknown}>(`${root}/validate`,async request=>service.validate(requirePrincipal(request),request.params.workspaceId,z.object({spec:JobDefinitionSpecRecordSchema}).strict().parse(request.body).spec))
  app.post<{ Params: Scope; Body: unknown }>(`${root}/launch/validate`, request => service.validateLaunch(
    requirePrincipal(request), request.params.workspaceId, JobLaunchValidationInputSchema.parse(request.body)))
  app.post<{Params:Scope;Body:unknown}>(`${root}/executions`, async request => ({
    admission: await service.enqueue(requirePrincipal(request), 'http', request.params.workspaceId,
      JobQueuedStartSchema.parse(request.body)),
  }))
  app.get<{Params:Scope;Querystring:Record<string,string>}>(`${root}/queue`, request => {
    const query = { ...request.query }
    const input = JobQueueListInputSchema.parse({ ...query,
      ...(query.historyLimit === undefined ? {} : { historyLimit: Number(query.historyLimit) }) })
    return service.listQueuePage(requirePrincipal(request), request.params.workspaceId, input)
  })
  app.get<{Params:Scope}>(`${root}/queue/:ticketId`, async request => ({
    ticket: await service.getQueueTicket(requirePrincipal(request), request.params.workspaceId,
      z.uuid().parse(request.params.ticketId)),
  }))
  app.post<{Params:Scope;Body:unknown}>(`${root}/queue/:ticketId/cancel`, async request => {
    const body = JobQueueCancelSchema.omit({ ticketId: true }).parse(request.body)
    const input = JobQueueCancelSchema.parse({ ...body, ticketId: request.params.ticketId })
    return { ticket: await service.cancelQueued(requirePrincipal(request), 'http', request.params.workspaceId, input) }
  })
  app.get<{Params:Scope}>(`${root}/executions`,async request=>({executions:await service.listExecutions(requirePrincipal(request),request.params.workspaceId)}))
  app.get<{Params:Scope}>(`${root}/executions/:executionId`,async request=>({execution:await service.getExecution(requirePrincipal(request),request.params.workspaceId,request.params.executionId)}))
  app.post<{Params:Scope;Body:unknown}>(`${root}/executions/:executionId/cancel`, async request => {
    const input = JobCancelInputSchema.parse(request.body)
    return { execution: await service.cancel(requirePrincipal(request), 'http', request.params.workspaceId,
      request.params.executionId, input.commandId, input.recovery) }
  })
  app.post<{Params:Scope;Body:unknown}>(`${root}/executions/:executionId/cancellation-recovery`, request => {
    const input = JobCancellationProposalInputSchema.omit({ workspaceId: true, executionId: true }).parse(request.body)
    return service.proposeCancellationRecovery(requirePrincipal(request), 'http', JobCancellationProposalInputSchema.parse({
      ...input, workspaceId: request.params.workspaceId, executionId: request.params.executionId }))
  })
  app.get<{Params:Scope}>(`${root}/executions/:executionId/cancellation-recovery/:recoveryId`, request =>
    service.getCancellationRecovery(requirePrincipal(request), { workspaceId: request.params.workspaceId,
      executionId: request.params.executionId, recoveryId: request.params.recoveryId }))
  app.post<{Params:Scope;Body:unknown}>(`${root}/executions/:executionId/cancellation-recovery/:recoveryId/approve`, request => {
    const input = JobCancellationRecoveryApproveSchema.pick({ commandId: true }).parse(request.body)
    return service.approveCancellationRecovery(requirePrincipal(request), 'http', { ...input,
      workspaceId: request.params.workspaceId, executionId: request.params.executionId,
      recoveryId: request.params.recoveryId })
  })
  app.get<{Params:Scope;Querystring:unknown}>(`${root}/executions/:executionId/logs`,async request=>{
    const query=z.object({afterSequence:z.coerce.number().int().nonnegative().default(0),limit:z.coerce.number().int().min(1).max(100).default(50)}).strict().parse(request.query)
    return service.readLogs(requirePrincipal(request),request.params.workspaceId,request.params.executionId,query.afterSequence,query.limit)
  })
  app.get<{Params:Scope}>(`${root}/executions/:executionId/artifacts`,async request=>({artifacts:await service.listArtifacts(requirePrincipal(request),request.params.workspaceId,request.params.executionId)}))
  app.get<{Params:Scope}>(`${root}/executions/:executionId/artifacts/:fileId/revisions/:revisionId/content`,async(request,reply)=>{
    const {workspaceId,executionId,fileId,revisionId}=request.params
    const {artifact,bytes}=await service.readArtifact(requirePrincipal(request),workspaceId,executionId,fileId,revisionId)
    reply.header('content-type','application/octet-stream').header('content-disposition','attachment').header('x-content-type-options','nosniff').header('cache-control','no-store')
    reply.header('x-artifact-sha256',artifact.sha256)
    return reply.send(bytes)
  })
}
