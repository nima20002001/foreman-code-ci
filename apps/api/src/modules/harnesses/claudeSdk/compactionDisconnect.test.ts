import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CompactionState } from '@foreman-code/contracts'
import { expect, it, vi } from 'vitest'
import { saveClaudeCompactionResult } from './compactionResults.js'
import { deferred, fixture, scope, start } from './__tests__/sessionManager.js'

it.each(['stream error', 'decode error'] as const)(
  'settles compaction promptly after %s while cleanup is blocked and preserves recovery', async ending => {
    const parent = join(homedir(), '.cache', 'foreman-tmp')
    await mkdir(parent, { recursive: true })
    const profilePath = await mkdtemp(join(parent, 'claude-control-'))
    const localScope = { ...scope, profilePath }
    const failure = new Error(ending)
    const cleanup = deferred<void>()
    const abort = new AbortController()
    const f = fixture(() => raw => {
      if ((raw as { subtype?: string }).subtype === 'decode_failure') throw failure
      return []
    }, { scope: localScope })
    const restarted = fixture(undefined, { scope: localScope })
    const history = { cursor: { scope: 'scope', identity: 'identity', offset: 0 }, boundaries: [] }
    f.runner.compactionHistory = async () => history
    restarted.runner.compactionHistory = async () => history
    const open = f.runner.open
    f.runner.open = async input => {
      const session = await open(input)
      const close = session.close
      session.close = async () => { await cleanup.promise; await close() }
      return session
    }
    try {
      const session = await f.manager.attachSession({ harness: 'claude', providerVersion: '2.1.284',
        nativeSessionId: 'native-session' }, start)
      await f.frames.offer({ type: 'system', subtype: 'init', session_id: session.nativeSessionId,
        cwd: '/work', claude_code_version: '2.1.284', slash_commands: ['compact'] })
      await vi.waitFor(async () => expect((await f.manager.sessionControlCapabilities!(session)).compact.supported).toBe(true))
      let state: CompactionState | undefined
      let observedFailure: unknown
      const compact = f.manager.compactSession!(session, { requestId: 'pending-control',
        clientCorrelationId: 'pending-control', onProgress: async value => { state = value } }, abort.signal)
      const settled = compact.catch(error => { observedFailure = error })
      const message = await f.nextMessage()
      if (ending === 'stream error') f.frames.close(failure)
      else await f.frames.offer({ type: 'system', subtype: 'decode_failure', session_id: session.nativeSessionId })
      await vi.waitFor(() => expect(observedFailure).toBe(failure))
      await settled
      const pending = { ...state!, status: 'uncertain' as const }
      expect((await f.manager.reconcileCompaction!(session, pending)).status).toBe('uncertain')
      await expect(f.manager.compactSession!(session, { requestId: 'duplicate', clientCorrelationId: 'duplicate',
        onProgress: async () => undefined })).rejects.toThrow()
      expect(f.offers).toHaveBeenCalledOnce()
      cleanup.resolve()
      f.frames.close()
      await f.manager.dispose!()
      const rebound = await restarted.manager.attachSession(session, start)
      expect((await restarted.manager.reconcileCompaction!(rebound, pending)).status).toBe('uncertain')
      await saveClaudeCompactionResult({ ...localScope, nativeSessionId: session.nativeSessionId }, message.uuid, 'completed')
      expect((await restarted.manager.reconcileCompaction!(rebound, pending)).status).toBe('completed')
      expect(restarted.offers).not.toHaveBeenCalled()
    } finally {
      abort.abort()
      cleanup.resolve()
      f.frames.close()
      await f.manager.dispose!()
      await restarted.manager.dispose!()
      await rm(profilePath, { recursive: true, force: true })
    }
  },
)
