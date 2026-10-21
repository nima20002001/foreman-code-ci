import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { loadOrCreateWorkerIdentity, loadWorkerPairing, persistWorkerPairing, updateWorkerEndpoint } from './deviceIdentityNode.js'

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof fs>()
  return { ...actual, rename: vi.fn(actual.rename), unlink: vi.fn(actual.unlink) }
})

it('preserves the failed endpoint update and reports its failed temporary cleanup', async () => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await fs.mkdir(cache, { recursive: true })
  const root = await fs.mkdtemp(join(cache, 'identity-cleanup-'))
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  try {
    const identity = await loadOrCreateWorkerIdentity(root)
    const configuration = { formatVersion: 1 as const, mainId: randomUUID(), deviceId: randomUUID(),
      workerInstallationId: identity.workerInstallationId, keyRevision: 1, authorizationRevision: 1,
      endpoint: 'wss://main.example/device', mainPublicKeyFingerprint: 'a'.repeat(64),
      credential: 'b'.repeat(64), expiresAt: '2099-01-01T00:00:00Z' }
    await persistWorkerPairing(root, configuration)
    const primary = Object.assign(new Error('Rename failed'), { code: 'EACCES' })
    vi.mocked(fs.rename).mockRejectedValue(primary)
    vi.mocked(fs.unlink).mockRejectedValue(Object.assign(new Error('Cleanup failed'), { code: 'EIO' }))
    await expect(updateWorkerEndpoint(root, 'wss://other.example/device')).rejects.toBe(primary)
    expect((await loadWorkerPairing(root)).endpoint).toBe(configuration.endpoint)
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('"lastError":"EIO"'))
  } finally {
    vi.restoreAllMocks()
    await fs.rm(root, { recursive: true, force: true })
  }
})
