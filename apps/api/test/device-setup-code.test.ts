import { generateKeyPairSync,randomUUID } from 'node:crypto'
import { describe,expect,it } from 'vitest'
import { decodeWorkerIdentityRequest,decodeWorkerEnrollmentCode,encodeWorkerEnrollmentCode,DeviceSetupOptionsSchema } from '@foreman-code/contracts/device-setup'
import { workerIdentityRequestCode,verifiedWorkerIdentityRequest,verifiedWorkerEnrollmentCode } from '@foreman-code/contracts/device-setup-node'
import { publicKeyFingerprint } from '@foreman-code/contracts/device-identity-node'
function identity(){const keys=generateKeyPairSync('ed25519'),publicKey=keys.publicKey.export({type:'spki',format:'pem'}).toString();return {workerInstallationId:randomUUID(),publicKey,publicKeyFingerprint:publicKeyFingerprint(publicKey)}}
describe('bounded companion setup code contract',()=>{
  it('publishes a single canonical public identity code with no private key or grant',()=>{
    const value=identity(),code=workerIdentityRequestCode(value)
    expect(verifiedWorkerIdentityRequest(code)).toEqual({version:1,kind:'identity-request',...value})
    expect(Object.keys(decodeWorkerIdentityRequest(code))).toEqual(['version','kind','workerInstallationId','publicKey','publicKeyFingerprint'])
    expect(code).toMatch(/^GQLWR1\.[A-Za-z0-9_-]+$/)
  })
  it('preserves full-entropy grant and original request/expiry while binding the actual local key',()=>{
    const value=identity(),requestId=randomUUID(),expiresAt='2099-01-01T00:00:00.000Z',grant='A'.repeat(43)
    const code=encodeWorkerEnrollmentCode({version:1,kind:'enrollment',workerInstallationId:value.workerInstallationId,publicKeyFingerprint:value.publicKeyFingerprint,enrollment:{mainId:randomUUID(),mainPublicKeyFingerprint:'1'.repeat(64),endpoint:'wss://192.168.1.12:7443/device/connect',grant,requestId},expiresAt})
    const parsed=verifiedWorkerEnrollmentCode(code,value)
    expect(parsed.enrollment.grant).toBe(grant);expect(parsed.enrollment.requestId).toBe(requestId);expect(parsed.expiresAt).toBe(expiresAt)
    expect(()=>verifiedWorkerEnrollmentCode(code,identity())).toThrow('IDENTITY_MISMATCH')
    expect(()=>verifiedWorkerEnrollmentCode(code,value,Date.parse(expiresAt))).toThrow('EXPIRED')
    expect(decodeWorkerEnrollmentCode(code)).toEqual(parsed)
  })
  it('rejects malformed/oversized/cross-kind request codes and incorrect fingerprint',()=>{
    expect(()=>decodeWorkerIdentityRequest('GQLWR1.'+'A'.repeat(8193))).toThrow()
    expect(()=>decodeWorkerIdentityRequest('GQLWE1.abc')).toThrow()
    expect(()=>decodeWorkerIdentityRequest('GQLWR1.abc=')).toThrow()
    const value=identity();expect(()=>workerIdentityRequestCode({...value,publicKeyFingerprint:'0'.repeat(64)})).toThrow('IDENTITY_INVALID')
  })
  it('denies insecure endpoints and fabricated available options',()=>{
    expect(DeviceSetupOptionsSchema.safeParse({endpoint:null,available:true,reason:null}).success).toBe(false)
    expect(DeviceSetupOptionsSchema.safeParse({endpoint:'ws://127.0.0.1/device/connect',available:true,reason:null}).success).toBe(false)
    expect(DeviceSetupOptionsSchema.safeParse({endpoint:'wss://192.168.1.12/device/connect?grant=secret',available:true,reason:null}).success).toBe(false)
    expect(DeviceSetupOptionsSchema.parse({endpoint:null,available:false,reason:'listener-unconfigured'}).available).toBe(false)
  })
})
