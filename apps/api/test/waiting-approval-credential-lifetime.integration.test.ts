import { it } from 'vitest'
import { assertWaitingApprovalCredentialLifetime } from './helpers/waitingApprovalCredentialLifetime.js'

it('retains the same requester credential across two lifetimes and resumes through http', async () => {
  await assertWaitingApprovalCredentialLifetime('http')
}, 180_000)

