import type pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import { fileToolFixture } from '../../../test/support/fileTools.js'
import { FILE_SESSION_LEASE_MS, FILE_SESSION_RENEWAL_WINDOW_MS } from '../files/tools/context.js'
import * as fileProduction from '../harnesses/claudeSdk/fileProduction.js'
import { createMainWorkerClaudeFiles } from './mainWorkerClaudeFiles.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('revokes each remote Claude file session after its call settles and stops renewing it', async () => {
  vi.useFakeTimers()
  const f = await fileToolFixture()
  vi.setSystemTime(f.clock())
  const identity = { ownerPrincipalId: f.context.ownerPrincipalId, attemptId: 'request',
    nativeSessionId: f.context.nativeSessionId, nativeMessageId: 'message',
    clientCorrelationId: 'correlation', generation: 'query', toolUseId: 'root-tool' }
  vi.spyOn(fileProduction, 'productionClaudeFileAdmission').mockReturnValue({ current: async () => ({
    context: { ...f.context, turnId: undefined, nativeMessageId: identity.nativeMessageId },
    expiresAt: new Date(f.principal.expiresAt),
  }) })
  const issued = vi.spyOn(f.sessions, 'issueForAcceptedSession')
  const renew = vi.spyOn(f.sessions, 'renew')
  const list = vi.spyOn(f.service, 'list')
  const manager = createMainWorkerClaudeFiles({ pool: {} as pg.Pool,
    binding: { kind: 'agent', workspaceId: 'workspace-a', conversationId: 'conversation-a',
      repository: { pending: async () => {} } },
    service: () => f.service, allowMutation: true })
  try {
    for (const outcome of ['success', 'failure', 'success'] as const) {
      const failure = new Error('The file read failed')
      if (outcome === 'failure') list.mockRejectedValueOnce(failure)
      const callback = { ...identity, toolUseId: `tool-${outcome}-${issued.mock.calls.length}` }
      const result = manager.call({ phase: 'file', identity: callback, operation: 'files.list', args: { scope: f.scope } },
        callback, new AbortController().signal)
      if (outcome === 'failure') await expect(result).rejects.toBe(failure)
      else expect(await result).toMatchObject({ items: [] })
      const token = await issued.mock.results.at(-1)!.value
      await expect.soft(f.sessions.authenticate(token)).rejects.toMatchObject({ code: 'FILE_SESSION_EXPIRED' })
    }
    const elapsed = FILE_SESSION_LEASE_MS - FILE_SESSION_RENEWAL_WINDOW_MS
    f.advance(elapsed)
    await vi.advanceTimersByTimeAsync(elapsed)
    expect(issued).toHaveBeenCalledTimes(3)
    expect(renew).not.toHaveBeenCalled()
  } finally { await manager.close() }
})
