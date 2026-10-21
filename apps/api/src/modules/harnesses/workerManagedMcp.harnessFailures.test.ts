import { rm } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { WorkerManagedMcp } from './workerManagedMcp.js'
import { deviceManagedMcpFixture } from '../../../test/helpers/deviceManagedMcp.js'
import { DomainError } from '../errors.js'

it('repairs Claude even when the Codex repair fails and reports the failure', async () => {
  const f = await deviceManagedMcpFixture()
  const failure = new DomainError('CODEX_SIGNED_OUT', 'Codex is signed out.', 409)
  vi.spyOn(f.adapters.codex, 'read').mockRejectedValue(failure)
  const worker = new WorkerManagedMcp({ directory: f.directory, adapters: f.adapters,
    installLauncher: async () => {} })
  try {
    await expect(worker.ensureReady(['codex', 'claude'])).rejects.toThrow()
    expect((await worker.list('claude', new AbortController().signal)).presets.graphql).toBe('installed')
    await expect(worker.list('codex', new AbortController().signal)).rejects.toBe(failure)
  } finally { await rm(f.directory, { recursive: true, force: true }) }
})
