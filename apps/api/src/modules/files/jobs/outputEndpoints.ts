import { settleObserved } from '../../diagnostics/ignoredError.js'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { McpServer } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { JobOutputPublicationInputSchema } from '@foreman-code/contracts/job-output-transfer'
import { TransferIntentSchema } from '@foreman-code/contracts/byte-transfer'
import { JobArtifactSchema } from '@foreman-code/contracts/jobs'
import type { PostgresDeviceAccessService } from '../../devices/access.js'
import type { DeviceEndpoint } from '../../devices/deviceEndpoint.js'
import { DomainError } from '../../errors.js'
import { toolFailure, toolResult } from '../../../mcp/shared/results.js'
import { JOB_OUTPUT_NAMESPACE, type PostgresJobOutputAdmission } from './outputAdmission.js'
import type { CanonicalJobArtifactPort } from './port.js'

/** Metadata parity on a separately mounted device-only surface. No Operator/browser credential exchange. */
export function registerJobOutputMetadataEndpoints(app:FastifyInstance,input:{access:PostgresDeviceAccessService;
  endpoint:Pick<DeviceEndpoint,'currentBinding'>;admission:PostgresJobOutputAdmission;artifacts:CanonicalJobArtifactPort}) {
  const authenticate=async(request:FastifyRequest)=>{
    if(request.headers.cookie!==undefined || request.headers.origin!==undefined)throw new DomainError('JOB_OUTPUT_DEVICE_REQUIRED','This surface requires the actual worker device credential.',401)
    const token=/^Bearer (.+)$/.exec(request.headers.authorization??'')?.[1]
    if(!token)throw new DomainError('JOB_OUTPUT_DEVICE_REQUIRED','This surface requires the actual worker device credential.',401)
    const device=await input.access.authenticateDevice(token,'heartbeat')
    const binding=input.endpoint.currentBinding(device.deviceId,JOB_OUTPUT_NAMESPACE)
    if(!binding || binding.mainId!==device.mainId || binding.workerInstallationId!==device.workerInstallationId || binding.keyRevision!==device.keyRevision || binding.authorizationRevision!==device.authorizationRevision)throw new DomainError('JOB_OUTPUT_CONNECTION_STALE','The authenticated device does not have a current ready output channel.',403)
    return binding
  }
  app.post('/device/job-outputs/admit',{bodyLimit:16384,onRequest:async request=>{await authenticate(request)}},async(request,reply)=>{
    const binding=await authenticate(request),output=JobOutputPublicationInputSchema.parse(request.body)
    reply.header('cache-control','no-store')
    return input.admission.onAuthenticatedChannel(binding,()=>input.admission.admit(output,'http'))
  })
  app.post('/device/job-outputs/publish',{bodyLimit:16384,onRequest:async request=>{await authenticate(request)}},async(request,reply)=>{
    const binding=await authenticate(request),output=JobOutputPublicationInputSchema.parse(request.body)
    reply.header('cache-control','no-store')
    return input.admission.onAuthenticatedChannel(binding,async()=>{await input.admission.requireAdmission(output);return (await input.artifacts.publishAccepted(output,'http')).artifact})
  })
  app.post('/device/mcp/job-outputs',{bodyLimit:32768,onRequest:async request=>{await authenticate(request)}},async(request,reply)=>{
    const binding=await authenticate(request)
    const server=new McpServer({name:'graphql-worker-job-outputs',version:'1.0.0'},{instructions:
      'Worker-only output metadata for the actual accepted closed job. No job-start, source editing, browser/Operator credential exchange or arbitrary transfer/root IDs. Bulk bytes use the authenticated binary carrier.'})
    const invoke=async(operation:()=>Promise<unknown>)=>{try{return toolResult(await input.admission.onAuthenticatedChannel(binding,operation))}catch(error){return toolFailure(error)}}
    server.registerTool('job_output_admit',{inputSchema:JobOutputPublicationInputSchema,outputSchema:TransferIntentSchema,
      description:'Main registers canonical ownership and durably issues the exact output transfer after current device/grant/root/attempt/physical closure checks. commandId retries original receipt; changed metadata conflicts.',
      annotations:{readOnlyHint:false,idempotentHint:true,destructiveHint:false,openWorldHint:false}},output=>invoke(()=>input.admission.admit(output,'mcp')))
    server.registerTool('job_output_publish',{inputSchema:JobOutputPublicationInputSchema,outputSchema:JobArtifactSchema,
      description:'Publish only verified bytes of the original main-admitted transfer through canonical storage and ledger. Never infer job completion from transfer progress.',
      annotations:{readOnlyHint:false,idempotentHint:true,destructiveHint:false,openWorldHint:false}},output=>invoke(async()=>{await input.admission.requireAdmission(output);return (await input.artifacts.publishAccepted(output,'mcp')).artifact}))
    const transport=new NodeStreamableHTTPServerTransport({sessionIdGenerator:undefined})
    reply.raw.once('close',()=>{void settleObserved('http', 'close disconnected MCP resources', [transport.close(), server.close()])})
    reply.header('cache-control','no-store');await server.connect(transport);reply.hijack();await transport.handleRequest(request.raw,reply.raw,request.body)
  })
}
