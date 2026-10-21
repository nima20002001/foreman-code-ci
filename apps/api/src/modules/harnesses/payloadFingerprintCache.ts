import { createHash } from 'node:crypto'
import { createReadStream, type BigIntStats } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'

function statIdentity(value: BigIntStats): string {
  return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':')
}

/** Reuse digests only while the full nanosecond file identity is unchanged. */
export class PayloadFingerprintCache {
  private readonly entries = new Map<string, { identity: string; fingerprint: string }>()

  async fingerprint(file: string, options: {
    signal?: AbortSignal | undefined
    observation?: BigIntStats
  } = {}): Promise<string> {
    const { signal, observation } = options
    signal?.throwIfAborted()
    const path = await realpath(file)
    const before = observation ?? await stat(path, { bigint: true })
    if (!before.isFile()) throw new Error('Payload is not a file')
    const identity = statIdentity(before)
    const cached = this.entries.get(path)
    if (cached?.identity === identity) {
      signal?.throwIfAborted()
      const after = await stat(path, { bigint: true })
      if (statIdentity(after) !== identity || await realpath(file) !== path) {
        this.entries.delete(path)
        throw new Error('Payload changed during fingerprinting')
      }
      signal?.throwIfAborted()
      return cached.fingerprint
    }
    this.entries.delete(path)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path, { ...(signal ? { signal } : {}) })) hash.update(chunk)
    signal?.throwIfAborted()
    const after = await stat(path, { bigint: true })
    if (statIdentity(after) !== identity || await realpath(file) !== path) {
      throw new Error('Payload changed during fingerprinting')
    }
    signal?.throwIfAborted()
    const fingerprint = hash.digest('hex')
    if (this.entries.size >= 512) this.entries.delete(this.entries.keys().next().value!)
    this.entries.set(path, { identity, fingerprint })
    return fingerprint
  }
}

export const inventoryPayloadFingerprints = new PayloadFingerprintCache()
