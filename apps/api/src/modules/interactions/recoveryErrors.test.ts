import { expect, it } from 'vitest'
import { settleReviewCleanup } from './reviewerCleanup.js'
import type { ReviewJob } from '@foreman-code/contracts'
import { readOperationalFailures } from '../diagnostics/logger.js'
import { productionSubagentControls } from '../subagents/productionControls.js'

it('retains pending review cleanup and reports its observation failure', async () => {
  const job = { state: 'failed', cleanup: { nativeState: 'pending', credentialState: 'revoked',
    interruptState: 'not_sent' } } as ReviewJob
  const result = await settleReviewCleanup({ job, session: { harness: 'codex', providerVersion: 'fixture',
    nativeSessionId: 'session' }, ownsTurn: true, check: async () => undefined,
    observe: async () => { throw Object.assign(new Error('Read unavailable'), { code: 'EIO' }) },
    persist: async cleanup => ({ ...job, cleanup }) })
  expect(result.cleanup?.nativeState).toBe('pending')
  expect(readOperationalFailures()).toContainEqual(expect.objectContaining({ operation: 'observe review cleanup', lastError: 'EIO' }))
})

it('reports unexpected resident lookup failures while excluding the unavailable child', () => {
  const controls = productionSubagentControls({ residentForRead: () => {
    throw Object.assign(new Error('Lookup unavailable'), { code: 'EIO' })
  } })
  expect(controls({ provider: 'codex', parentExecutionId: 'execution' } as never)).toBeUndefined()
  expect(readOperationalFailures()).toContainEqual(expect.objectContaining({ operation: 'read resident subagent controls', lastError: 'EIO' }))
})
