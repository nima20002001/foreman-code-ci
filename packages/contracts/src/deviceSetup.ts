import { optionalCommandId } from './management/commands.js'
import { z } from 'zod'
import { WorkerEnrollmentInputSchema,DeviceRegistrationSchema,DeviceScopeSchema,DeviceTlsTrustSchema } from './deviceIdentity.js'
const DEVICE_SETUP_CODE_MAX=8192
export const WorkerIdentityRequestSchema=z.object({version:z.literal(1),kind:z.literal('identity-request'),workerInstallationId:z.uuid(),publicKey:z.string().min(1).max(1024),publicKeyFingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict()
const WorkerEnrollmentCodeSchema=z.object({version:z.literal(1),kind:z.literal('enrollment'),workerInstallationId:z.uuid(),publicKeyFingerprint:z.string().regex(/^[a-f0-9]{64}$/),enrollment:WorkerEnrollmentInputSchema.refine(value=>{const endpoint=new URL(value.endpoint);return endpoint.protocol==='wss:'&&endpoint.pathname==='/device/connect'},'Use the approved WSS device endpoint.'),expiresAt:z.string().datetime(),tlsTrust:DeviceTlsTrustSchema.optional()}).strict()
export type WorkerIdentityRequest=z.infer<typeof WorkerIdentityRequestSchema>
export type WorkerEnrollmentCode=z.infer<typeof WorkerEnrollmentCodeSchema>
function encode(prefix:string,value:unknown):string {const bytes=new TextEncoder().encode(JSON.stringify(value));let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);const code=prefix+btoa(binary).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');if(code.length>DEVICE_SETUP_CODE_MAX)throw new Error('DEVICE_SETUP_CODE_INVALID');return code}
function decode(prefix:string,raw:string):unknown {try{const code=raw.trim();if(code.length>DEVICE_SETUP_CODE_MAX||!code.startsWith(prefix))throw new Error();const value=code.slice(prefix.length);if(!/^[A-Za-z0-9_-]+$/.test(value)||value.length%4===1)throw new Error();const binary=atob(value.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-value.length%4)%4));const json=new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(binary,char=>char.charCodeAt(0)));const parsed:unknown=JSON.parse(json);if(encode(prefix,parsed)!==code)throw new Error();return parsed}catch{throw new Error('DEVICE_SETUP_CODE_INVALID')}}
export function encodeWorkerIdentityRequest(value:WorkerIdentityRequest):string {return encode('GQLWR1.',WorkerIdentityRequestSchema.parse(value))}
export function decodeWorkerIdentityRequest(code:string):WorkerIdentityRequest {return WorkerIdentityRequestSchema.parse(decode('GQLWR1.',code))}
/** Private credential envelope. Never place this code in URLs, argv or logs. */
export function encodeWorkerEnrollmentCode(value:WorkerEnrollmentCode):string {return encode('GQLWE1.',WorkerEnrollmentCodeSchema.parse(value))}
export function decodeWorkerEnrollmentCode(code:string):WorkerEnrollmentCode {return WorkerEnrollmentCodeSchema.parse(decode('GQLWE1.',code))}

export const DeviceSetupApproveInputSchema=z.object({commandId:optionalCommandId(z.string().min(8).max(200)),identityRequestCode:z.string().min(1).max(DEVICE_SETUP_CODE_MAX),endpoint:WorkerEnrollmentInputSchema.shape.endpoint,scopes:z.array(DeviceScopeSchema).min(1).max(3),expectedAuthorizationRevision:z.number().int().positive().optional()}).strict().refine(value=>{const endpoint=new URL(value.endpoint);return endpoint.protocol==='wss:'&&endpoint.pathname==='/device/connect'},'Use the approved LAN WSS device endpoint.')
export const DeviceSetupApproveResultSchema=z.object({
  registration:DeviceRegistrationSchema,
  enrollmentCode:z.string().max(DEVICE_SETUP_CODE_MAX),
  expiresAt:z.string().datetime().describe('Enrollment code expiry, one hour after creation; retries retain the original expiry.'),
}).strict()
export type DeviceSetupApproveInput=z.infer<typeof DeviceSetupApproveInputSchema>

export const DeviceSetupOptionsSchema=z.object({endpoint:WorkerEnrollmentInputSchema.shape.endpoint.nullable(),available:z.boolean(),tlsTrust:DeviceTlsTrustSchema.optional(),reason:z.enum(['listener-unconfigured','endpoint-unconfigured','listener-not-started']).nullable()}).strict().superRefine((value,ctx)=>{if(value.available&&(value.endpoint===null||value.reason!==null)||!value.available&&value.reason===null)ctx.addIssue({code:'custom',message:'Actual setup configuration availability and reason must agree.'});if(value.endpoint!==null){const endpoint=new URL(value.endpoint);if(endpoint.protocol!=='wss:'||endpoint.pathname!=='/device/connect')ctx.addIssue({code:'custom',path:['endpoint'],message:'Use the explicit approved LAN WSS device endpoint.'})}})
export type DeviceSetupOptions=z.infer<typeof DeviceSetupOptionsSchema>
