import { JobRuntimeApprovalRecordSchema, JobRuntimeProfileRecordSchema, JobRuntimeProfileListRecordSchema,
  JobRuntimeProfileSaveRecordSchema, JobRuntimeQualificationReadRecordSchema }
  from '@foreman-code/contracts/job-verification-runtime'
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { JobRuntimeQualificationRequestSchema, JobRuntimeQualificationCommandSchema } from '@foreman-code/contracts/job-runtime'
import type { ManagementAction, ManagementPrincipal } from '@foreman-code/contracts/management'
import { hasAction, isAuthorized, type AuthorizedResource } from '../../../modules/access/policy.js'
import type { JobRuntimeProfiles } from '../../../modules/jobs/runtimeProfiles.js'
import { BUILD_COMPUTER_PREPARE_ACTIONS, type CiRuntimeProvisioner } from '../../../modules/jobs/ciRuntimeProvisioner.js'
import { BuildComputerPrepareGetInputSchema, BuildComputerPrepareInputSchema, BuildComputerPrepareStatusSchema } from '@foreman-code/contracts'
import type { PostgresCommandCoordinator } from '../../../modules/commands/postgres.js'
import { DomainError } from '../../../modules/errors.js'
import { toolFailure, toolResult } from '../../shared/results.js'
import { CiEnrollmentReadSchema, CiEnrollmentUpdateSchema, CiEnrollmentStateSchema } from '@foreman-code/contracts'
import { CI_ENROLLMENT_ACTIONS, type CiEnrollment } from '../../../modules/jobs/ciEnrollment.js'
export const JOB_RUNTIME_TOOLS=['job_runtime_profile_list','job_runtime_profile_save','job_runtime_qualification_request','job_runtime_qualification_run','job_runtime_qualification_get','build_computer_prepare','build_computer_prepare_get','ci_enrollment_get','ci_enrollment_update'] as const
export type JobRuntimeToolName=typeof JOB_RUNTIME_TOOLS[number]
interface Context {principal:ManagementPrincipal;services:{jobRuntimeProfiles?:JobRuntimeProfiles;ciRuntime?:CiRuntimeProvisioner;ciEnrollment?:CiEnrollment;commands:PostgresCommandCoordinator}}
const action=(name:JobRuntimeToolName)=>name==='job_runtime_profile_list'||name==='job_runtime_qualification_get'||name==='build_computer_prepare_get'?'job_definitions:read' as const:'job_definitions:write' as const
function requiredActions(name: JobRuntimeToolName): ManagementAction[] {
  if (name === 'ci_enrollment_get') return ['job_definitions:read']
  if (name === 'ci_enrollment_update') return CI_ENROLLMENT_ACTIONS
  if (name === 'job_runtime_profile_save') return [action(name), 'sources:read', 'source_roots:read']
  if (name === 'build_computer_prepare') return [...BUILD_COMPUTER_PREPARE_ACTIONS]
  return [action(name)]
}
export function jobRuntimeToolAvailable(context:Context,name:JobRuntimeToolName,resource:AuthorizedResource={}) {
  if (name.startsWith('ci_enrollment_') && !context.services.ciEnrollment) return false
  if (name.startsWith('build_computer_prepare') && !context.services.ciRuntime) return false
  return !!context.services.jobRuntimeProfiles && requiredActions(name).every(required =>
    Object.keys(resource).length ? isAuthorized(context.principal, required, resource) : hasAction(context.principal, required))
}
export function jobRuntimeCapabilities(context:Context,resource:AuthorizedResource) {
  return JOB_RUNTIME_TOOLS.filter(name=>jobRuntimeToolAvailable(context,name,resource)).map(name=>({
    name, actions: requiredActions(name), detail: jobRuntimeCapabilityDetail(name),
  }))
}
function jobRuntimeCapabilityDetail(name: JobRuntimeToolName): string {
  if (name === 'ci_enrollment_get') {
    return 'Read per-computer workspace CI enrollment, persisted disable choices and per-template results, '
      + 'including executionMode. Host CI reports runner readiness without runtime profiles or preparation. '
      + 'Globally disabled builds report how to enable them with build_computer_update. '
      + 'Protected runtime results include pairing-managed setup and migration status, missing workspace profiles '
      + '(templates-required), '
      + 'storage availability, preparation failures '
      + 'and ordinary templates not enrolled automatically.'
  }
  if (name === 'ci_enrollment_update') {
    return 'Enable, retry or disable workspace CI enrollment with revision checks and idempotent commands. '
      + 'commandId is optional and generated server-side when omitted. '
      + 'Host CI checks runner readiness without preparing legacy runtimes; globally disabled builds remain disabled. '
      + 'For protected runtimes, enabling adopts pairing-approved product-managed storage and binds a writable root, '
      + 'preserves verification templates’ resource envelopes and prepares installed runtimes. Arbitrary user paths '
      + 'require explicit root approval. Insufficient storage and ordinary templates are reported without automatic enrollment.'
  }
  if (name === 'build_computer_prepare') {
    return 'Prepare and refresh Main’s legacy CI runtime using approved workspace roots. '
      + 'commandId is optional and generated server-side when omitted. '
      + 'Paired Workers use Host CI through ci_run and reject legacy runtime refresh. '
      + 'Requires all preparation grants; installer paths are selected by the installed runtime.'
  }
  if (name === 'job_runtime_profile_list') {
    return 'Read CI policy profiles and readiness without probing or installing. Authorized writers can use '
      + 'build_computer_prepare for Main’s legacy runtime; paired Workers use Host CI through ci_run.'
  }
  return 'Read/save existing-root CI policy metadata, capture an installed candidate on a paired, authorized '
    + 'computer and run or reconcile its qualification with the original command. GET performs no probe or installation.'
}
async function invoke(context:Context,name:JobRuntimeToolName,work:()=>Promise<unknown>) {
  try{return toolResult(await work())}catch(error){
    if(error instanceof DomainError&&error.status===403)await context.services.commands.recordDenied(context.principal.id,'mcp',name,`mcp:${name}`)
    return toolFailure(error)
  }
}
export function registerJobRuntimeTools(server:McpServer,context:Context) {
  const service=context.services.jobRuntimeProfiles
  if(!service)return
  const scope=z.object({workspaceId:z.string().min(1)}).strict(),approval=scope.extend({approvalId:z.string().uuid()})
  const read={readOnlyHint:true,idempotentHint:true,openWorldHint:false},write={readOnlyHint:false,idempotentHint:true,openWorldHint:false}
  const enrollment = context.services.ciEnrollment
  if (enrollment && jobRuntimeToolAvailable(context, 'ci_enrollment_get')) {
    server.registerTool('ci_enrollment_get', {
      description: jobRuntimeCapabilityDetail('ci_enrollment_get')
        + ' Protected runtimes without active profiles report templates-required; save a verification profile with '
        + 'job_runtime_profile_save. Failed protected preparations use exponential backoff capped at one hour. '
        + 'Reads do not install, prepare or qualify runtimes. Requires job_definitions:read.',
      inputSchema: CiEnrollmentReadSchema, outputSchema: CiEnrollmentStateSchema, annotations: read,
    }, input => invoke(context, 'ci_enrollment_get', () => enrollment.read(context.principal, input)))
  }
  if (enrollment && jobRuntimeToolAvailable(context, 'ci_enrollment_update')) {
    server.registerTool('ci_enrollment_update', {
      description: jobRuntimeCapabilityDetail('ci_enrollment_update')
        + ' Read ci_enrollment_get for persisted results. Requires build_computer_prepare grants plus '
        + 'workspace_locations:validate/update. Build participation is a separate global setting controlled by '
        + 'build_computer_update; enabling workspace enrollment does not change it. Host CI uses ci_run.',
      inputSchema: CiEnrollmentUpdateSchema, outputSchema: CiEnrollmentStateSchema,
      annotations: { ...write, openWorldHint: true },
    }, input => invoke(context, 'ci_enrollment_update', () => enrollment.update(context.principal, 'mcp', input)))
  }
  if(jobRuntimeToolAvailable(context,'job_runtime_profile_list'))server.registerTool('job_runtime_profile_list',{description:'Read existing CI policy profiles, captured qualification fingerprints and metadata readiness without probing or installing. Qualifying and recovery-required operations include their original runCommandId and runPrincipalId; the original authorized principal retries that command with job_runtime_qualification_run. Authorized writers can use build_computer_prepare to prepare and refresh Main’s legacy CI runtime using approved workspace roots. Paired Workers use Host CI through ci_run and reject legacy runtime refresh. Preparation requires its own grants; arbitrary installer paths are unavailable through MCP.',inputSchema:scope,outputSchema:JobRuntimeProfileListRecordSchema,annotations:read},input=>invoke(context,'job_runtime_profile_list',()=>service.list(context.principal,input.workspaceId)))
  if(jobRuntimeToolAvailable(context,'job_runtime_profile_save'))server.registerTool('job_runtime_profile_save',{description:'Save a revisioned CI policy for an existing approved root. Build and verification records retain their formats. Verification saves the approved source commit, offline network policy and reviewed 24-hour lifetime; activation requires measured runtime resources. Caller cannot declare review, qualification evidence or readiness.',inputSchema:JobRuntimeProfileSaveRecordSchema.extend({workspaceId:z.string().min(1)}),outputSchema:z.object({profile:JobRuntimeProfileRecordSchema}),annotations:write},input=>invoke(context,'job_runtime_profile_save',async()=>{const{workspaceId,...body}=input;return {profile:await service.save(context.principal,'mcp',workspaceId,body)}}))
  if(jobRuntimeToolAvailable(context,'job_runtime_qualification_request'))server.registerTool('job_runtime_qualification_request',{description:'Capture the exact installed candidate on a paired, authorized computer; run job_runtime_qualification_run next, with no approval step. This does not probe or install the runtime. Verification candidates bind the saved source commit and profile; another commit requires a new capture. Native entry uses the original guarded runtime owner.',inputSchema:JobRuntimeQualificationRequestSchema.extend({workspaceId:z.string().min(1)}),outputSchema:z.object({approval:JobRuntimeApprovalRecordSchema}),annotations:write},input=>invoke(context,'job_runtime_qualification_request',async()=>{const{workspaceId,...body}=input;return {approval:await service.requestQualification(context.principal,'mcp',workspaceId,body)}}))
  if(jobRuntimeToolAvailable(context,'job_runtime_qualification_run'))server.registerTool('job_runtime_qualification_run',{description:'Run the captured qualification through its guarded host owner. Verification qualification requires jobs:start and job_artifacts:read in addition to job_definitions:write, and retains ordinary-suite and interruption reports as readable canonical Jobs. Long operations retain their start and result in the worker journal. Retry the same command as its original authorized principal to reconcile its result and cleanup, including after candidate expiry or a profile edit. Reconciliation retains the original lease and does not launch another diagnostic; expired or superseded evidence cannot replace current readiness.',inputSchema:approval.extend({commandId:JobRuntimeQualificationCommandSchema.shape.commandId}),outputSchema:z.object({profile:JobRuntimeProfileRecordSchema}),annotations:write},input=>invoke(context,'job_runtime_qualification_run',async()=>({profile:await service.qualify(context.principal,'mcp',input.workspaceId,input.commandId,input.approvalId)})))
  if(jobRuntimeToolAvailable(context,'job_runtime_qualification_get'))server.registerTool('job_runtime_qualification_get',{description:'Read the requested qualification candidate, retained Main native admission and historical measured evidence separately from the current profile and its metadata readiness. A Worker clock offset greater than 2 minutes blocks qualification/readiness with its reason in readback. Current readiness uses profile.measurement, which can belong to a newer qualification. Failed suites retain the exit code and report Job executionId in readiness reasons; read those reports with job_artifacts_list and job_artifact_read. Admission records ownership and is not qualification evidence.',inputSchema:approval,outputSchema:JobRuntimeQualificationReadRecordSchema,annotations:read},input=>invoke(context,'job_runtime_qualification_get',()=>service.getQualification(context.principal,input.workspaceId,input.approvalId)))
  const ci=context.services.ciRuntime
  if(ci&&jobRuntimeToolAvailable(context,'build_computer_prepare'))server.registerTool('build_computer_prepare',{description:'Prepare Main\'s legacy CI runtime for a commit once it has an installed CI runtime (default: the workspace repository\'s default branch). Paired Workers use Host CI through ci_run and reject legacy runtime refresh. The computer fetches the commit from the workspace GitHub repository, builds its offline package seed and verification image (or reuses its existing image when the commit\'s dependency inputs and installed runtime controls are unchanged; a still-ready qualification of that same image is kept without requalifying), Main moves every verification profile on that computer to the commit and image, Main refreshes its protected runtime, restarts itself and resumes the preparation, and Main requalifies each profile. Runs in the background; follow it with build_computer_prepare_get. One preparation per physical computer across workspaces. Image builds use at most half the computer CPUs and memory; preparationLimits reports those caps. Current registration and build settings are rechecked before admission and each background step; revoked or changed registrations stop preparation and retain its failed status. A different command while one runs reports CI_RUNTIME_BUSY; retry it later. The same command resumes or reads its persisted operation after Main restarts. Requires job_definitions:read, job_definitions:write, sources:approve, sources:read, source_roots:bind, source_roots:read, workspace_locations:read, jobs:start and job_artifacts:read in the workspace.',inputSchema:BuildComputerPrepareInputSchema,outputSchema:BuildComputerPrepareStatusSchema,annotations:{...write,openWorldHint:true}},input=>invoke(context,'build_computer_prepare',()=>ci.start(context.principal,'mcp',input)))
  if(ci&&jobRuntimeToolAvailable(context,'build_computer_prepare_get'))server.registerTool('build_computer_prepare_get',{description:'Read the CI runtime preparation of the computer that holds this verification profile: approving, preparing (with its build stage), binding, refreshing, qualifying, qualified or failed (with the reason), each profile\'s revision and status, and whether the image and qualification were reused (with the source commit of the reused qualification). Includes preparationLimits (CPU count and memory bytes) and cache status, lastError, missCount and rebuildCount for this preparation. Includes consecutive failureCount and retryAt; automatic enrollment waits until retryAt before retrying, with exponential backoff capped at one hour. Explicit preparation commands can retry immediately. Repository captures of the same workspace, commit, location and tracked inventory are reused while retained. Reads persisted progress across Main restarts; idle when this workspace has no preparation for the computer. Requires job_definitions:read.',inputSchema:BuildComputerPrepareGetInputSchema,outputSchema:BuildComputerPrepareStatusSchema,annotations:read},input=>invoke(context,'build_computer_prepare_get',()=>ci.get(context.principal,input)))
}

export async function unavailableJobRuntimeToolCall(context:Context,body:unknown) {
  const call=z.object({jsonrpc:z.literal('2.0'),id:z.union([z.string(),z.number().int()]),method:z.literal('tools/call'),params:z.object({name:z.enum(JOB_RUNTIME_TOOLS)}).passthrough()}).passthrough().safeParse(body)
  if(!call.success||jobRuntimeToolAvailable(context,call.data.params.name))return undefined
  return {jsonrpc:'2.0' as const,id:call.data.id,result:await invoke(context,call.data.params.name,async()=>{throw new DomainError(context.services.jobRuntimeProfiles?'ACCESS_DENIED':'JOB_RUNTIME_UNAVAILABLE','CI runtime metadata or the required grant is unavailable.',context.services.jobRuntimeProfiles?403:503)})}
}
