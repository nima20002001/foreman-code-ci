import { expect, it } from 'vitest'
import { CodexAppServerSessionManager, type CodexSessionDependencies } from './codexAppServer.js'
import { readOperationalFailures } from '../diagnostics/logger.js'
import { inspectNativeResponse } from './responseAvailability.js'
import { fixtureProtocol } from '../../../test/fixtures/codex-test-helpers.js'
import { RECORDED_CODEX_VERSION } from '../../../test/fixtures/codex-version.js'

it.each(['completion', 'disconnect', 'expiry', 'request failure'])('retains and reports login cleanup after %s', async trigger => {
  const before = readOperationalFailures().find(item => item.operation === 'clean up Codex login')?.failureCount ?? 0
  let notify: ((method: string, params: Record<string, unknown>) => void) | undefined
  let disconnect: ((error: Error) => void) | undefined
  let expire: (() => void) | undefined
  let failClose = true
  const failure = Object.assign(new Error('Cleanup unavailable'), { code: 'EIO' })
  const dependencies: Extract<CodexSessionDependencies, { mode: 'replay' }> = {
    mode: 'replay', environment: () => ({}),
    qualify: async binary => ({ binary, identity: 'fixture', protocol: fixtureProtocol,
      providerVersion: RECORDED_CODEX_VERSION, schemaManifestSha256: 'fixture',
      stableSchemaGitBlob: 'fixture', referenceSchemaManifestSha256: 'fixture' }),
    assertUnchanged: async () => undefined, qualifyModel: async () => undefined,
    runCommand: async () => ({ stdout: '[]', stderr: '', exitCode: 0, exitSignal: null }),
    id: () => 'fixture', now: () => new Date(), cancelTimer: () => undefined,
    schedule: ((work: () => void) => { expire = work; return { unref: () => undefined } }) as unknown as typeof setTimeout,
    withDiagnostics: async (_pin, work) => work(dependencies),
    transport: (...args) => {
      notify = args[5]
      disconnect = args[6]
      return { start: async () => undefined, respond: async () => undefined, reject: async () => undefined,
        request: async () => {
          if (trigger === 'request failure') throw new Error('Login request failed')
          return { loginId: 'login' }
        }, close: async () => { if (failClose) throw failure } }
    },
  }
  const manager = new CodexAppServerSessionManager('/fixture/codex', undefined, undefined, undefined,
    undefined, undefined, dependencies)
  try {
    if (trigger === 'request failure') await expect(manager.startDeviceCodeLogin()).rejects.toThrow('Login request failed')
    else {
      await manager.startDeviceCodeLogin()
      if (trigger === 'completion') notify?.('account/login/completed', {})
      if (trigger === 'disconnect') disconnect?.(new Error('Disconnected'))
      if (trigger === 'expiry') expire?.()
      await Promise.resolve()
      await Promise.resolve()
    }
    expect(readOperationalFailures()).toContainEqual(expect.objectContaining({ operation: 'clean up Codex login', lastError: 'EIO',
      failureCount: before + 1 }))
  } finally {
    failClose = false
    await manager.shutdown()
  }
})

it('keeps response availability fail-closed and reports an unexpected inspection failure', async () => {
  const session = { harness: 'codex', nativeSessionId: 'session', providerVersion: 'fixture' } as const
  const query = { nativeRequestId: 'request', nativeRequestType: 'approval' } as const
  const result = await inspectNativeResponse({ inspectResponseAvailability: async () => {
    throw Object.assign(new Error('Inspection unavailable'), { code: 'EIO' })
  } }, session, query, { isCurrent: () => true })
  expect(result.state).toBe('unavailable')
  expect(readOperationalFailures()).toContainEqual(expect.objectContaining({ operation: 'inspect native response availability', lastError: 'EIO' }))
})
