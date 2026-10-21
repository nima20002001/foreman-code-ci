import { constants } from 'node:fs'
import { open, realpath, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { X509Certificate, createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { createSecureContext } from 'node:tls'
import type { DeviceListenerConfig } from './productionConfig.js'

export async function readOwnedDeviceTlsFile(path: string): Promise<Buffer> {
  if (await realpath(path) !== resolve(path)) throw new Error('Device TLS files must not use symbolic links.')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 65536) {
      throw new Error('Device TLS files must be owner-only regular files owned by Main’s OS user.')
    }
    return await file.readFile()
  } finally {
    await file.close()
  }
}

export async function readDeviceTlsMaterials(config: DeviceListenerConfig) {
  const certificate = await readOwnedDeviceTlsFile(config.certificateFile)
  const key = await readOwnedDeviceTlsFile(config.privateKeyFile)
  const x509 = new X509Certificate(certificate)
  createSecureContext({ cert: certificate, key, minVersion: 'TLSv1.2' })
  if (config.advertisedEndpoint) {
    const hostname = new URL(config.advertisedEndpoint).hostname.replace(/^\[|\]$/g, '')
    if (!(isIP(hostname) ? x509.checkIP(hostname) : x509.checkHost(hostname))) {
      throw new Error('The approved device TLS certificate does not match its public endpoint.')
    }
  }
  let publicTrust: import('@foreman-code/contracts/device-identity').DeviceTlsTrust | undefined
  if (config.trustCertificateFile) {
    const certificatePem = await readFile(config.trustCertificateFile, 'utf8')
    if (Buffer.byteLength(certificatePem) > 8192 || /PRIVATE KEY/.test(certificatePem)
      || (certificatePem.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length !== 1) {
      throw new Error('The approved public device trust anchor is invalid.')
    }
    const ca = new X509Certificate(certificatePem)
    if (!ca.ca || !x509.verify(ca.publicKey)) {
      throw new Error('The approved device TLS leaf is not signed by its app-specific CA.')
    }
    publicTrust = { certificatePem, sha256: createHash('sha256').update(ca.raw).digest('hex') }
  }
  return { certificate, key, publicTrust }
}
