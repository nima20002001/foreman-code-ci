import { WorkflowJobListInputSchema, WorkflowJobPageSchema } from '@foreman-code/contracts/job-verification'
import { JobCancelInputSchema, JobCancellationProposalInputSchema, JobCancellationRecoveryGetSchema,
  JobCancellationRecoveryReadSchema, JobCancellationRecoveryApproveSchema, SignedJobCancellationGrantSchema } from '@foreman-code/contracts/job-cancellation-recovery'
import { JobWorkflowExecutionReferenceSchema } from '@foreman-code/contracts/job-workflow'
import { JobAdmissionResultSchema, JobQueuedStartSchema, JobQueueCancelSchema,
  JobQueueTicketSchema, JobQueueListInputSchema, JobQueuePageSchema,
  JobLaunchValidationInputSchema, JobLaunchValidationSchema } from '@foreman-code/contracts/job-admission'
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { JobArtifactSchema, JobArtifactReadInputSchema, JobArtifactReadOutputSchema, JobLogPageSchema, JobValidationSchema } from '@foreman-code/contracts/jobs'
import {
  JobAuthoringChoicesRecordSchema,
  JobDefinitionSaveRecordSchema,
  JobDefinitionRecordSchema,
  JobDefinitionSpecRecordSchema,
  JobExecutionRecordSchema,
} from '@foreman-code/contracts/job-verification'
import type { ManagementAction, ManagementPrincipal } from '@foreman-code/contracts/management'
import { hasAction, isAuthorized, type AuthorizedResource } from '../../../modules/access/policy.js'
import { DomainError } from '../../../modules/errors.js'
import type { JobService } from '../../../modules/jobs/service.js'
import type { PostgresCommandCoordinator } from '../../../modules/commands/postgres.js'
import { toolFailure, toolResult } from '../../shared/results.js'
import { componentLogger } from '../../../infrastructure/logger.js'
const log = componentLogger('jobs')
export const JOB_TOOLS = [
  'job_choices_get', 'job_workflow_execution_get', 'job_definition_list', 'job_definition_get',
  'job_definition_version_get', 'job_definition_save', 'job_validate', 'job_launch_validate', 'job_start',
  'job_queue_get', 'job_queue_list', 'job_queue_cancel', 'job_get', 'job_list', 'job_workflow_list', 'job_cancel',
  'job_cancellation_recovery_propose', 'job_cancellation_recovery_get', 'job_cancellation_recovery_approve', 'job_logs_read',
  'job_artifacts_list', 'job_artifact_read',
] as const
export type JobToolName = typeof JOB_TOOLS[number]
const actions:Record<JobToolName,ManagementAction> = {
  job_launch_validate: 'jobs:start',
  job_cancellation_recovery_approve: 'jobs:cancel',
  job_workflow_list: 'jobs:read',
  job_choices_get:'job_definitions:read',job_workflow_execution_get:'jobs:read',job_definition_list:'job_definitions:read',job_definition_get:'job_definitions:read',job_definition_version_get:'job_definitions:read',job_definition_save:'job_definitions:write',job_validate:'job_definitions:read',
  job_start:'jobs:start',job_get:'jobs:read',job_list:'jobs:read',job_cancel:'jobs:cancel',job_cancellation_recovery_propose:'jobs:cancel',job_cancellation_recovery_get:'jobs:cancel',job_logs_read:'job_logs:read',job_artifacts_list:'job_artifacts:read',job_artifact_read:'job_artifacts:read',
  job_queue_get: 'jobs:read', job_queue_list: 'jobs:read', job_queue_cancel: 'jobs:cancel',
}
export const JOB_QUEUE_CAPABILITY_DETAIL = 'Standalone build Jobs require owner-reviewed Main queue configuration and support saved Auto or fixed placement. '
  + 'Requests wait for capacity before source preparation. '
  + 'Auto selects an authorized eligible computer with available capacity by build priority; fixed placement waits for its saved computer. '
  + 'Start placement overrides select Auto, a preferred computer with build-order fallback, or an explicit computer/root against the saved security and resource requirements, without editing the definition. '
  + 'job_launch_validate checks the saved revision and override with jobs:start authority; canQueue is separate from current readiness. '
  + 'Agent-triggered CI records initiatingAgent separately from workflow-node membership; reads retain this provenance. '
  + 'Execution, log and artifact reads enforce workspace, workflow and Run grants using the persisted origin. '
  + 'Queue lists accept workflowId for workflow-wide requests or initiatingExecutionId for one Agent execution; '
  + 'Agent-filtered queue reads and workflow Job references authorize the persisted workflow and Run. '
  + 'Workflow-node queuing and start estimates are not implemented. '
  + 'Queue reads require jobs:read and have no side effects; enqueue requires jobs:start and cancellation requires jobs:cancel. '
  + 'Live grants, saved revisions, command retries and original execution identities remain enforced.'
export interface JobMcpContext {principal:ManagementPrincipal;services:{jobs?:JobService;commands:PostgresCommandCoordinator}}
export function jobToolAvailable(context:JobMcpContext,name:JobToolName,resource:AuthorizedResource={}) {
  return !!context.services.jobs && (Object.keys(resource).length ? isAuthorized(context.principal,actions[name],resource) : hasAction(context.principal,actions[name]))
}
export function jobCapabilities(context:JobMcpContext,resource:AuthorizedResource) {
  return JOB_TOOLS.filter(name => jobToolAvailable(context, name, resource)).map(name => ({
    name, actions: [actions[name]],
    detail: name === 'job_workflow_list'
      ? 'Read workflow-node and Agent-triggered CI executions for one workflow, newest first, with cursor paging. Requires jobs:read for that workspace and workflow.'
      : name.startsWith('job_cancellation_recovery')
      ? 'Cleanup requires scoped jobs:cancel. Operators can propose, authorize and import signed no-entry cleanup; this never authorizes execution.'
      : JOB_QUEUE_CAPABILITY_DETAIL + ' Accepted specifications and file revisions are immutable. '
        + 'No Agent, provider login or Operator credential enters the build.',
  }))
}
async function invoke(context:JobMcpContext,name:JobToolName,work:()=>Promise<unknown>) {
  try {return toolResult(await work())} catch(error) {
    if(error instanceof DomainError && error.status===403) await context.services.commands.recordDenied(context.principal.id,'mcp',name,`mcp:${name}`)
    if (!(error instanceof DomainError)) log.error({ err: error, tool: name }, 'Job tool failed')
    return toolFailure(error)
  }
}
export function registerJobTools(server:McpServer,context:JobMcpContext):void {
  const service=context.services.jobs
  if(!service) return
  const scope=z.object({workspaceId:z.string().min(1)}).strict()
  const execution=scope.extend({executionId:z.string().min(1)}).strict()
  const read={readOnlyHint:true,idempotentHint:true,openWorldHint:false}
  const write={readOnlyHint:false,idempotentHint:true,openWorldHint:false}
  if (jobToolAvailable(context, 'job_choices_get')) server.registerTool('job_choices_get', {
    description: 'Read authorized CI sources, fixed computer/root choices, Auto runtime requirements and repository '
      + 'verification templates. Templates retain the saved resource envelope, qualified worker allowance, wrapper '
      + 'command and four required reports. Unqualified or offline profiles remain authorable; readiness is checked '
      + 'at Start. Each template ready flag reflects its current runtime readiness. No installation or provider login.',
    inputSchema: scope, outputSchema: JobAuthoringChoicesRecordSchema, annotations: read,
  }, input => invoke(context, 'job_choices_get', () => service.choices(context.principal, input.workspaceId, 'mcp')))
  if(jobToolAvailable(context,'job_workflow_execution_get')) server.registerTool('job_workflow_execution_get',{description:'Read the persisted relationship from a Run node execution to its JobExecutionRecord. Requires jobs:read for its persisted workspace, workflow and Run. IDs are never inferred or borrowed from another Run.',inputSchema:scope.extend({runId:z.string().min(1),nodeExecutionId:z.string().min(1)}),outputSchema:z.object({reference:JobWorkflowExecutionReferenceSchema}),annotations:read},input=>invoke(context,'job_workflow_execution_get',async()=>({reference:await service.getWorkflowExecutionReference(context.principal,input.workspaceId,input.runId,input.nodeExecutionId,'mcp')})))
  if(jobToolAvailable(context,'job_definition_list')) server.registerTool('job_definition_list',{description:'List workspace job definitions.',inputSchema:scope,outputSchema:z.object({definitions:z.array(JobDefinitionRecordSchema)}),annotations:read},input=>invoke(context,'job_definition_list',async()=>({definitions:await service.listDefinitions(context.principal,input.workspaceId,'mcp')})))
  if(jobToolAvailable(context,'job_definition_get')) server.registerTool('job_definition_get',{description:'Read an exact workspace job definition and revision.',inputSchema:scope.extend({definitionId:z.string().min(1)}),outputSchema:z.object({definition:JobDefinitionRecordSchema}),annotations:read},input=>invoke(context,'job_definition_get',async()=>({definition:await service.getDefinition(context.principal,input.workspaceId,input.definitionId,'mcp')})))
  if(jobToolAvailable(context,'job_definition_version_get')) server.registerTool('job_definition_version_get',{description:'Read one exact immutable saved job version. Current definition edits never substitute its source, target, command or policy.',inputSchema:scope.extend({definitionId:z.string().min(1),versionId:z.string().min(1)}),outputSchema:z.object({definition:JobDefinitionRecordSchema}),annotations:read},input=>invoke(context,'job_definition_version_get',async()=>({definition:await service.getDefinitionVersion(context.principal,input.workspaceId,input.definitionId,input.versionId,'mcp')})))
  if (jobToolAvailable(context, 'job_definition_save')) server.registerTool('job_definition_save', {
    description: 'Create or edit an Auto or fixed build or verification Job with command receipt and optimistic '
      + 'revision. Verification retains its suite, parameters, resource request and report declarations from '
      + 'job_choices_get templates, identified by profile ID, profile revision and suite. Auto limits must equal '
      + 'verification.resources.limits; update both when editing resources or choosing runtime requirements. '
      + 'Auto saves source, command, inputs, outputs and runtime requirements without '
      + 'an online computer. Selection and capacity are checked when the queued request is claimed. '
      + 'No execution or installation.',
    inputSchema: JobDefinitionSaveRecordSchema.extend({ workspaceId: z.string().min(1) }),
    outputSchema: z.object({ definition: JobDefinitionRecordSchema }), annotations: write,
  }, input => invoke(context, 'job_definition_save', async () => {
    const { workspaceId, ...body } = input
    return { definition: await service.saveDefinition(context.principal, 'mcp', workspaceId, body) }
  }))
  if(jobToolAvailable(context,'job_validate')) server.registerTool('job_validate',{description:'Validate static Auto source/configuration authority or fixed-target readiness without installation. Computer eligibility and capacity are rechecked when the queued request is claimed; unavailable computers can wait.',inputSchema:scope.extend({spec:JobDefinitionSpecRecordSchema}),outputSchema:JobValidationSchema,annotations:read},input=>invoke(context,'job_validate',()=>service.validate(context.principal,input.workspaceId,input.spec,'mcp')))
  if (jobToolAvailable(context, 'job_launch_validate')) server.registerTool('job_launch_validate', {
    description: 'Check a saved Job revision and optional Start computer override without queuing, reservation or '
      + 'preparation. Requires jobs:start. canQueue reports configuration and authorization; valid reports current '
      + 'computer readiness and capacity. A temporarily unavailable computer can wait in the queue. '
      + 'The queue rechecks eligibility before launch.',
    inputSchema: JobLaunchValidationInputSchema.extend({ workspaceId: z.string().min(1) }),
    outputSchema: JobLaunchValidationSchema, annotations: read,
  }, input => invoke(context, 'job_launch_validate', () => {
    const { workspaceId, ...body } = input
    return service.validateLaunch(context.principal, workspaceId, body, 'mcp')
  }))
  if (jobToolAvailable(context, 'job_start')) server.registerTool('job_start', {
    description: JOB_QUEUE_CAPABILITY_DETAIL + ' Persist a request using the saved definition revision. '
      + 'The Job runs the source commit captured by that queued request, even when the source-root head advances. '
      + 'The admission result is pending with a ticket or accepted with the original executionId. Retrying a retained pre-queue command returns its original execution without creating a ticket. '
      + 'Retry the same commandId and payload after an unknown acknowledgment; read job_queue_get for waiting or claim state and job_get after acceptance. '
      + 'Claimed cancellation and disconnected execution do not prove process closure or released capacity.',
    inputSchema: JobQueuedStartSchema.extend({ workspaceId: z.string().min(1) }),
    outputSchema: z.object({ admission: JobAdmissionResultSchema }), annotations: write,
  }, input => invoke(context, 'job_start', async () => {
    const { workspaceId, ...body } = input
    return { admission: await service.enqueue(context.principal, 'mcp', workspaceId, body) }
  }))
  if (jobToolAvailable(context, 'job_queue_get')) server.registerTool('job_queue_get', {
    description: 'Read one build queue ticket with jobs:read for its persisted workspace, workflow and Run. '
      + 'Includes original enqueue/deadline, state, waiting reasons, compatible-target count and workspace queue position. '
      + 'Claimed tickets expose the persisted selected computer, root binding and runtime profile; cleanup status shows retained capacity after cancellation or terminal execution. '
      + 'Source capacity waits retain the reservation and expose sourceCapacityWait with bounded retryAt and attempts. '
      + 'Accepted tickets reference the original executionId. Start estimates are unknown. No selection or launch.',
    inputSchema: scope.extend({ ticketId: z.uuid() }),
    outputSchema: z.object({ ticket: JobQueueTicketSchema }), annotations: read,
  }, input => invoke(context, 'job_queue_get', async () => ({
    ticket: await service.getQueueTicket(context.principal, input.workspaceId, input.ticketId, 'mcp'),
  })))
  if (jobToolAvailable(context, 'job_queue_list')) server.registerTool('job_queue_list', {
    description: 'Read every active workspace-scoped build request plus a page of completed request history. '
      + 'Use nextHistoryCursor as historyBeforeSequence to read older history; active requests appear on every page. '
      + 'Filter by workflowId for all requests in one workflow, or initiatingExecutionId for one Agent execution’s CI requests. '
      + 'Requires jobs:read for the selected workflow and, for an Agent filter, its persisted Run. '
      + 'historyLimit bounds history only. Queue positions describe this workspace. Reading never starts work.',
    inputSchema: scope.extend(JobQueueListInputSchema.shape), outputSchema: JobQueuePageSchema, annotations: read,
  }, input => invoke(context, 'job_queue_list', () => {
    const { workspaceId, ...page } = input
    return service.listQueuePage(context.principal, workspaceId, page, 'mcp')
  }))
  if (jobToolAvailable(context, 'job_queue_cancel')) server.registerTool('job_queue_cancel', {
    description: 'Cancel a standalone build request with its current ticket revision and a retryable commandId. '
      + 'Waiting cancellation persists without contacting a computer. Claimed or accepted cancellation keeps the original attempt and retains capacity until confirmed closure. '
      + 'Read-only callers cannot cancel; a cancellation request is not confirmation that processes stopped.',
    inputSchema: JobQueueCancelSchema.extend({ workspaceId: z.string().min(1) }),
    outputSchema: z.object({ ticket: JobQueueTicketSchema }), annotations: write,
  }, input => invoke(context, 'job_queue_cancel', async () => {
    const { workspaceId, ...body } = input
    return { ticket: await service.cancelQueued(context.principal, 'mcp', workspaceId, body) }
  }))
  if(jobToolAvailable(context,'job_get')) server.registerTool('job_get',{description:'Read accepted job and separate process, transport and publication facts. Requires jobs:read scoped to its persisted workspace, workflow and Run.',inputSchema:execution,outputSchema:z.object({execution:JobExecutionRecordSchema}),annotations:read},input=>invoke(context,'job_get',async()=>({execution:await service.getExecution(context.principal,input.workspaceId,input.executionId,'mcp')})))
  if(jobToolAvailable(context,'job_list')) server.registerTool('job_list',{description:'List workspace job executions.',inputSchema:scope,outputSchema:z.object({executions:z.array(JobExecutionRecordSchema)}),annotations:read},input=>invoke(context,'job_list',async()=>({executions:await service.listExecutions(context.principal,input.workspaceId,'mcp')})))
  if (jobToolAvailable(context, 'job_workflow_list')) server.registerTool('job_workflow_list', {
    description: 'Read accepted Job history for one workflow, including workflow job nodes and Agent-triggered CI. '
      + 'Newest first, at most 50 rows per page. Pass nextCursor as cursor for older rows. '
      + 'Names come from the accepted immutable Job version. Requires scoped jobs:read; no side effects.',
    inputSchema: scope.extend({ workflowId: z.string().min(1), ...WorkflowJobListInputSchema.shape }),
    outputSchema: WorkflowJobPageSchema, annotations: read,
  }, input => invoke(context, 'job_workflow_list', () => {
    const { workspaceId, workflowId, ...page } = input
    return service.listWorkflowExecutions(context.principal, workspaceId, workflowId, page, 'mcp')
  }))
  if (jobToolAvailable(context, 'job_cancel')) server.registerTool('job_cancel', {
    description: 'Request cancellation of the original Job. Pending journal state does not prove physical closure. For a revoked Worker, recovery requires a fresh jobs:cancel-authorized grant and the original installation signed no-entry/source-claim closure. Recovery never authorizes execution or publication.',
    inputSchema: JobCancelInputSchema.extend({ workspaceId: z.string().min(1), executionId: z.string().min(1) }),
    outputSchema: z.object({ execution: JobExecutionRecordSchema }), annotations: write,
  }, input => invoke(context, 'job_cancel', async () => ({ execution: await service.cancel(context.principal,
    'mcp', input.workspaceId, input.executionId, input.commandId, input.recovery) })))
  if (jobToolAvailable(context, 'job_cancellation_recovery_propose')) server.registerTool('job_cancellation_recovery_propose', {
    description: 'Propose cleanup of one original manual Job on a revoked Worker, pinned to its retained journal digest. Authorize the proposal with job_cancellation_recovery_approve using scoped jobs:cancel before importing its signed closure.',
    inputSchema: JobCancellationProposalInputSchema, outputSchema: JobCancellationRecoveryReadSchema, annotations: write,
  }, input => invoke(context, 'job_cancellation_recovery_propose', () =>
    service.proposeCancellationRecovery(context.principal, 'mcp', input)))
  if (jobToolAvailable(context, 'job_cancellation_recovery_approve')) server.registerTool('job_cancellation_recovery_approve', {
    description: 'Authorize the original cleanup proposal with scoped jobs:cancel. Returns a short-lived signed grant for no-entry cleanup and release of the original source claim. Reuse commandId and input for retries. Worker identity and cancellation are rechecked; this never permits execution.',
    inputSchema: JobCancellationRecoveryApproveSchema, outputSchema: SignedJobCancellationGrantSchema, annotations: write,
  }, input => invoke(context, 'job_cancellation_recovery_approve', () =>
    service.approveCancellationRecovery(context.principal, 'mcp', input)))
  if (jobToolAvailable(context, 'job_cancellation_recovery_get')) server.registerTool('job_cancellation_recovery_get', {
    description: "Read this caller's original cleanup proposal, approved short-lived grant and persisted signed closure. A grant permits only no-entry fencing and release of its original source claim; ordinary revoked Worker authentication remains denied.",
    inputSchema: JobCancellationRecoveryGetSchema, outputSchema: JobCancellationRecoveryReadSchema, annotations: read,
  }, input => invoke(context, 'job_cancellation_recovery_get', () => service.getCancellationRecovery(context.principal, input)))
  if(jobToolAvailable(context,'job_logs_read')) server.registerTool('job_logs_read',{description:'Read sequenced log chunks; resume with nextCursor. Reports truncation. Requires job_logs:read scoped to the persisted job origin.',inputSchema:execution.extend({afterSequence:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(100).default(50)}),outputSchema:JobLogPageSchema,annotations:read},input=>invoke(context,'job_logs_read',()=>service.readLogs(context.principal,input.workspaceId,input.executionId,input.afterSequence,input.limit,'mcp')))
  if (jobToolAvailable(context, 'job_artifact_read')) server.registerTool('job_artifact_read', {
    description: 'Read digest-verified immutable artifact bytes as base64 in chunks up to 1 MiB. '
      + 'Keep fileId/revisionId unchanged and use nextOffset as offset until null. '
      + 'Requires job_artifacts:read scoped to the persisted job origin. '
      + 'Missing, expired or corrupt revisions fail. No HTTP download is required.',
    inputSchema: execution.extend(JobArtifactReadInputSchema.shape),
    outputSchema: JobArtifactReadOutputSchema, annotations: read,
  }, input => invoke(context, 'job_artifact_read', () =>
    service.readArtifactPage(context.principal, input.workspaceId, input.executionId, input)))
  if(jobToolAvailable(context,'job_artifacts_list')) server.registerTool('job_artifacts_list',{description:'Read retained job artifact file/revision/digest/size and expiry. Requires job_artifacts:read scoped to the persisted job origin; latest bytes never substitute the saved revision.',inputSchema:execution,outputSchema:z.object({artifacts:z.array(JobArtifactSchema)}),annotations:read},input=>invoke(context,'job_artifacts_list',async()=>({artifacts:await service.listArtifacts(context.principal,input.workspaceId,input.executionId,'mcp')})))
}
export async function unavailableJobToolCall(context:JobMcpContext,body:unknown) {
  const call=z.object({jsonrpc:z.literal('2.0'),id:z.union([z.string(),z.number().int()]),method:z.literal('tools/call'),params:z.object({name:z.enum(JOB_TOOLS)}).passthrough()}).passthrough().safeParse(body)
  if(!call.success||jobToolAvailable(context,call.data.params.name)) return undefined
  return {jsonrpc:'2.0' as const,id:call.data.id,result:await invoke(context,call.data.params.name,async()=>{
    throw new DomainError(context.services.jobs?'ACCESS_DENIED':'JOBS_UNAVAILABLE',context.services.jobs?'The caller lacks this job grant.':'Job services are not configured.',context.services.jobs?403:503)
  })}
}
