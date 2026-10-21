import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

let cleanupFailures = 0

async function requirePrivateFile(file: string): Promise<void> {
  const info = await lstat(file)
  if (!info.isFile() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) {
    throw new Error('Worker identity/configuration requires a private file owned by the worker account.')
  }
}
async function syncPath(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}
export interface WorkerLocalIdentity {
  formatVersion: 1
  workerInstallationId: string
  publicKey: string
  privateKey: string
  publicKeyFingerprint: string
  keyRevision: number
}
export function publicKeyFingerprint(publicKey: string): string {
  const key = createPublicKey(publicKey)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Worker identity requires an Ed25519 key.')
  if (publicKey.trim() !== key.export({ type: 'spki', format: 'pem' }).toString().trim()) {
    throw new Error('Publish only a canonical Ed25519 public key, never private key material.')
  }
  return createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex')
}
export async function loadOrCreateWorkerIdentity(directory: string): Promise<WorkerLocalIdentity> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const file = join(directory, 'identity.json')
  async function read(): Promise<WorkerLocalIdentity> {
    await requirePrivateFile(file)
    const identity = JSON.parse(await readFile(file, 'utf8')) as WorkerLocalIdentity
    if (identity.formatVersion !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identity.workerInstallationId)
      || !Number.isSafeInteger(identity.keyRevision) || identity.keyRevision < 1 || publicKeyFingerprint(identity.publicKey) !== identity.publicKeyFingerprint
      || publicKeyFingerprint(createPublicKey(createPrivateKey(identity.privateKey)).export({ type: 'spki', format: 'pem' }).toString()) !== identity.publicKeyFingerprint) {
      throw new Error('Worker identity is corrupt; explicit recovery is required.')
    }
    return identity
  }
  try { return await read() } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    await stat(join(directory, 'pairing.json'))
    throw new Error('Paired worker identity is missing; explicit recovery is required.')
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const identity: WorkerLocalIdentity = { formatVersion: 1, workerInstallationId: randomUUID(), publicKey,
    privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyFingerprint: publicKeyFingerprint(publicKey), keyRevision: 1 }
  const temporary = join(directory, `.identity-${randomUUID()}`)
  await writeFile(temporary, JSON.stringify(identity), { mode: 0o600, flag: 'wx' })
  await syncPath(temporary)
  try {
    try { await link(temporary, file) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  } finally { await unlink(temporary) }
  await syncPath(directory)
  return read()
}

/** Re-enrollment retains the pinned Main and device identity with a newer authorization. */
export async function persistWorkerPairing(directory: string, configuration: import('./deviceIdentity.js').WorkerPairingConfiguration): Promise<void> {
  const { WorkerPairingConfigurationSchema } = await import('./deviceIdentity.js')
  const parsed = WorkerPairingConfigurationSchema.parse(configuration)
  const identity = await loadOrCreateWorkerIdentity(directory)
  if (parsed.workerInstallationId !== identity.workerInstallationId || parsed.keyRevision !== identity.keyRevision) throw new Error('Pairing does not match local identity.')
  const file = join(directory, 'pairing.json'), temporary = join(directory, `.pairing-${randomUUID()}`)
  await writeFile(temporary, JSON.stringify(parsed), { mode: 0o600, flag: 'wx' })
  await syncPath(temporary)
  let replaced = false
  try {
    try { await link(temporary, file) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const previous = await loadWorkerPairing(directory)
      if (JSON.stringify(previous) !== JSON.stringify(parsed)) {
        if (previous.mainId !== parsed.mainId || previous.deviceId !== parsed.deviceId
          || previous.workerInstallationId !== parsed.workerInstallationId || previous.keyRevision !== parsed.keyRevision
          || previous.mainPublicKeyFingerprint !== parsed.mainPublicKeyFingerprint) {
          throw new Error('Worker is already paired; explicit unpairing is required.', { cause: error })
        }
        if (parsed.authorizationRevision <= previous.authorizationRevision) {
          throw new Error('Worker re-enrollment must advance authorization.', { cause: error })
        }
        await rename(temporary, file)
        replaced = true
      }
    }
    await syncPath(directory)
  } finally { if (!replaced) await unlink(temporary) }
}
export async function loadWorkerPairing(directory: string): Promise<import('./deviceIdentity.js').WorkerPairingConfiguration> {
  const { WorkerPairingConfigurationSchema } = await import('./deviceIdentity.js')
  await requirePrivateFile(join(directory, 'pairing.json'))
  const parsed = WorkerPairingConfigurationSchema.parse(JSON.parse(await readFile(join(directory, 'pairing.json'), 'utf8')))
  const identity = await loadOrCreateWorkerIdentity(directory)
  if (parsed.workerInstallationId !== identity.workerInstallationId || parsed.keyRevision !== identity.keyRevision) throw new Error('Pairing does not match local identity.')
  return parsed
}

/** Endpoint edits retain the selected authority and credential; the carrier must still authenticate the pinned main. */
export async function updateWorkerEndpoint(directory: string, endpoint: string): Promise<void> {
  const { WorkerPairingConfigurationSchema } = await import('./deviceIdentity.js')
  const configuration = WorkerPairingConfigurationSchema.parse({ ...await loadWorkerPairing(directory), endpoint })
  const temporary = join(directory, `.pairing-${randomUUID()}`)
  await writeFile(temporary, JSON.stringify(configuration), { mode: 0o600, flag: 'wx' })
  await syncPath(temporary)
  const { rename } = await import('node:fs/promises')
  try { await rename(temporary, join(directory, 'pairing.json')); await syncPath(directory) }
  catch (error) {
    await unlink(temporary).catch((cleanupError: unknown) => {
      const code = (cleanupError as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return
      console.warn(JSON.stringify({ operation: 'remove failed identity update', status: 'degraded',
        lastError: code ?? 'CLEANUP_FAILED', failureCount: ++cleanupFailures }))
    })
    throw error
  }
}

export function mainIdentityProofMessage(request: import('./deviceIdentity.js').MainIdentityProofRequest, mainApplicationVersion: string): string {
  return JSON.stringify([request.audience, request.mainId, request.nonce, request.workerInstallationId,
    request.deviceId ?? null, request.bootId ?? null, request.connectionGeneration ?? null,
    request.keyRevision ?? null, request.authorizationRevision ?? null, request.connectionEpoch ?? null, request.mainConnectionEpoch ?? null,
    request.protocolVersion, request.workerApplicationVersion, mainApplicationVersion, request.negotiationHash ?? null])
}
/** Fresh caller nonce and all claimed identity/version fields must match before accepting authority. */
export async function verifyMainIdentityProof(proof: unknown, expected: import('./deviceIdentity.js').MainIdentityProofRequest,
  expectedFingerprint: string): Promise<boolean> {
  const { MainIdentityProofRequestSchema, MainSignedIdentityProofSchema } = await import('./deviceIdentity.js')
  const { verify } = await import('node:crypto')
  try {
    const parsed = MainSignedIdentityProofSchema.parse(proof), request = MainIdentityProofRequestSchema.parse(expected)
    return parsed.mainPublicKeyFingerprint === expectedFingerprint
      && publicKeyFingerprint(parsed.mainPublicKey) === expectedFingerprint
      && mainIdentityProofMessage(parsed.request, parsed.mainApplicationVersion) === mainIdentityProofMessage(request, parsed.mainApplicationVersion)
      && verify(null, Buffer.from(mainIdentityProofMessage(parsed.request, parsed.mainApplicationVersion)), parsed.mainPublicKey, Buffer.from(parsed.signature, 'base64url'))
  } catch { return false }
}

export function mainEnrollmentProofMessage(request: import('./deviceIdentity.js').MainEnrollmentProofRequest, mainApplicationVersion: string): string {
  return JSON.stringify([request.audience, request.mainId, request.nonce, request.workerInstallationId,
    request.protocolVersion, request.workerApplicationVersion, mainApplicationVersion])
}
export async function verifyMainEnrollmentProof(proof: unknown, expected: import('./deviceIdentity.js').MainEnrollmentProofRequest,
  expectedFingerprint: string): Promise<boolean> {
  const { MainEnrollmentProofRequestSchema, MainSignedEnrollmentProofSchema } = await import('./deviceIdentity.js')
  const { verify } = await import('node:crypto')
  try {
    const parsed = MainSignedEnrollmentProofSchema.parse(proof), request = MainEnrollmentProofRequestSchema.parse(expected)
    return parsed.mainPublicKeyFingerprint === expectedFingerprint
      && publicKeyFingerprint(parsed.mainPublicKey) === expectedFingerprint
      && mainEnrollmentProofMessage(parsed.request, parsed.mainApplicationVersion) === mainEnrollmentProofMessage(request, parsed.mainApplicationVersion)
      && verify(null, Buffer.from(mainEnrollmentProofMessage(parsed.request, parsed.mainApplicationVersion)), parsed.mainPublicKey, Buffer.from(parsed.signature, 'base64url'))
  } catch { return false }
}

export function pairingProof(input: Omit<import('./deviceIdentity.js').DevicePairingRequest, 'signature'>): string {
  return JSON.stringify(['graphql-worker-pair-v1', input.mainId, input.workerInstallationId, publicKeyFingerprint(input.publicKey),
    input.requestId, createHash('sha256').update(input.grant).digest('hex')])
}
