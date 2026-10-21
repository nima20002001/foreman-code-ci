import { createHash,X509Certificate } from 'node:crypto'
import { DeviceTlsTrustSchema,type DeviceTlsTrust } from './deviceIdentity.js'
/** One approved public CA, scoped to this selected device endpoint only. */
export function deviceTlsOptions(value?:DeviceTlsTrust):{rejectUnauthorized:true;ca?:string} {
  if(!value)return {rejectUnauthorized:true}
  const trust=DeviceTlsTrustSchema.parse(value),pem=trust.certificatePem
  if((pem.match(/-----BEGIN CERTIFICATE-----/g)??[]).length!==1||(pem.match(/-----END CERTIFICATE-----/g)??[]).length!==1||!/^\s*-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(pem))throw new Error('DEVICE_TLS_TRUST_INVALID')
  const certificate=new X509Certificate(pem)
  if(!certificate.ca||createHash('sha256').update(certificate.raw).digest('hex')!==trust.sha256)throw new Error('DEVICE_TLS_TRUST_INVALID')
  return {rejectUnauthorized:true,ca:pem}
}
