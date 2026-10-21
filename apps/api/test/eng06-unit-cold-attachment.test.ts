import assert from 'node:assert/strict'
import { it } from 'vitest'
import { reviewerFixture } from './helpers/reviewerAudit.js'

it('a finalized reviewer without a workflow closure receipt cannot bypass cold recovery', async () => {
  const f = await reviewerFixture({ closedWorkflow: false })
  assert.equal(f.execution.state, 'completed')
  assert.equal((await f.coordination.workflowSession(f.execution.id))?.finalized, true)
  await assert.rejects(f.attach(), { code: 'NATIVE_SESSION_RECOVERY_REQUIRED' })
  assert.deepEqual(f.prepared, [])
  assert.deepEqual(f.attaches, [])
  assert.deepEqual(f.starts, [])
  assert.deepEqual(f.revoked, [])
})

it('a cold nonterminal requester cannot attach, prepare credentials or replay native work', async () => {
  const f = await reviewerFixture({ workflow: true })
  assert.notEqual(f.execution.state, 'completed')
  await assert.rejects(f.runtime.attachInteraction(f.interaction), { code: 'NATIVE_SESSION_RECOVERY_REQUIRED' })
  assert.deepEqual(f.prepared, [])
  assert.deepEqual(f.attaches, [])
  assert.deepEqual(f.starts, [])
  assert.deepEqual(f.cancellations, [])
})
