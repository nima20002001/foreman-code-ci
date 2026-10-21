import { it } from 'vitest'
import { assertWaitingApprovalCredentialLifetime } from './helpers/waitingApprovalCredentialLifetime.js'

it('retains the same requester credential across two lifetimes and resumes through mcp', async () => {
  await assertWaitingApprovalCredentialLifetime('mcp')
}, 180_000)
