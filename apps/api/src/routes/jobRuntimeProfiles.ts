import { JobRuntimeProfileSaveRecordSchema } from '@foreman-code/contracts/job-verification-runtime'
import type { FastifyInstance } from 'fastify'
import { JobRuntimeQualificationCommandSchema } from '@foreman-code/contracts/job-runtime'
import { z } from 'zod'
import { requirePrincipal } from '../modules/access/http.js'
import type { JobRuntimeProfiles } from '../modules/jobs/runtimeProfiles.js'
import type { CiRuntimeProvisioner } from '../modules/jobs/ciRuntimeProvisioner.js'
interface Scope {workspaceId:string;profileId:string;approvalId:string}
export function registerJobRuntimeProfileRoutes(app:FastifyInstance,service:JobRuntimeProfiles,ci?:CiRuntimeProvisioner):void {
  const root='/api/management/workspaces/:workspaceId/jobs'
  app.get<{Params:Scope}>(`${root}/runtime-profiles`,request=>service.list(requirePrincipal(request),request.params.workspaceId))
  app.post<{Params:Scope;Body:unknown}>(`${root}/runtime-profiles`,async request=>({profile:await service.save(requirePrincipal(request),'http',request.params.workspaceId,JobRuntimeProfileSaveRecordSchema.parse(request.body))}))
  app.post<{Params:Scope;Body:unknown}>(`${root}/runtime-profiles/:profileId/qualification-requests`,async request=>{
    const input=z.object({commandId:z.string().min(1),expectedRevision:z.number().int().positive()}).strict().parse(request.body)
    return {approval:await service.requestQualification(requirePrincipal(request),'http',request.params.workspaceId,{...input,profileId:request.params.profileId})}
  })
  app.get<{Params:Scope}>(`${root}/runtime-qualifications/:approvalId`,request=>service.getQualification(requirePrincipal(request),request.params.workspaceId,request.params.approvalId))
  app.post<{Params:Scope;Body:unknown}>(`${root}/runtime-qualifications/:approvalId/run`,async request=>({profile:await service.qualify(requirePrincipal(request),'http',request.params.workspaceId,JobRuntimeQualificationCommandSchema.parse(request.body).commandId,request.params.approvalId)}))
  if(!ci)return
  // The build computer that holds this profile: prepare its CI runtime for a commit, then follow it.
  app.get<{Params:Scope}>(`${root}/runtime-profiles/:profileId/computer-preparation`,request=>ci.get(requirePrincipal(request),{workspaceId:request.params.workspaceId,profileId:request.params.profileId}))
  app.post<{Params:Scope;Body:unknown}>(`${root}/runtime-profiles/:profileId/computer-preparation`,request=>{
    const input=z.object({commandId:z.string().min(1),commit:z.string().optional()}).strict().parse(request.body)
    return ci.start(requirePrincipal(request),'http',{...input,workspaceId:request.params.workspaceId,profileId:request.params.profileId})
  })
}
