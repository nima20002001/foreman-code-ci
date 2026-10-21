import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CODEX_ADVANCED_CONFIGURATION } from '@foreman-code/contracts'
import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'
import { input } from './fixtures/codex-test-helpers.js'
import { CodexApprovalProvider } from './helpers/codexApprovalProvider.js'

// The replay records native request settings; the production adapter builds them.
describe('Codex native approval configuration', () => {
  it.each(['never', 'on-request'] as const)('forwards the %s policy to the native session', async approvalPolicy => {
    expect(DEFAULT_CODEX_ADVANCED_CONFIGURATION.approvalPolicy).toBe('never')
    const source = input(process.cwd())
    const provider = new CodexApprovalProvider(source.request.executionId, false)
    const dependencies = provider.dependencies()
    const manager = new CodexAppServerSessionManager('/recorded-no-native-codex', undefined, undefined,
      undefined, 'scoped', undefined, dependencies)
    const harness = source.request.configuration.harness
    if (harness.harness !== 'codex') throw new Error('Expected Codex configuration')
    if (approvalPolicy === 'on-request') harness.advanced = { ...DEFAULT_CODEX_ADVANCED_CONFIGURATION, approvalPolicy }
    try {
      const session = await manager.createSession(source)
      expect(provider.threads.get(session.nativeSessionId)?.settings.approvalPolicy).toBe(approvalPolicy)
      expect(await manager.pending(session)).toBeUndefined()
      if (approvalPolicy === 'on-request') {
        const streamed = (async () => {
          for await (const event of manager.startTurn(session, { prompt: 'Request native approval',
            clientCorrelationId: `execution:${source.request.executionId}` })) void event
        })()
        const outcome = Promise.allSettled([streamed])
        await vi.waitFor(async () => expect(await manager.pending(session)).toBeDefined())
        const pending = (await manager.pending(session))!
        expect(pending.nativeRequestType).toBe('item/commandExecution/requestApproval')
        const option = pending.responseOptions.find(value => value.semantic === 'approve_once')!
        await manager.respond(session, pending.turn.nativeRequestId!, option)
        await streamed
        expect(await outcome).toMatchObject([{ status: 'fulfilled' }])
        expect(provider.responses).toHaveLength(1)
        expect((await manager.history(session)).terminalResult?.outcome).toBe('succeeded')
      }
    } finally {
      await manager.dispose()
    }
  })
})
