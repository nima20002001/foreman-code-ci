import { describe, expect, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { lifecycleFixtures } from './helpers/workflowLifecycleFixtures.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { approvalResponse } from './helpers/approvalResponse.js'
import { graphParity } from './helpers/wave25R1GraphParity.js'

// Provider transport is deterministic; admission, capture, checkpointing and lifecycle writers remain real.
describe.skipIf(!postgresEnabled)('native workflow lifecycle: approvals', () => {
  const fixture = lifecycleFixtures()

  it('authenticates the real launch credential and revokes it at Stop', async () => {
    const f = await fixture(), tokens: string[] = []
    const access = new PostgresAccessService(f.db.pool)
    const original = f.provider.createSession.bind(f.provider)
    vi.spyOn(f.provider, 'createSession').mockImplementation(async (input) => {
      const token = input.environment?.variables.GRAPHQL_MCP_TOKEN
      if (token) {
        await expect(access.authenticate(token, 'worker')).resolves.toMatchObject({ audience: 'worker' })
        tokens.push(token)
      }
      return original(input)
    })
    await f.engine.start(f.f.run.id)
    expect(tokens).toHaveLength(3)
    await f.stop(); await f.engine.cancel(f.f.run.id)
    await expect(access.authenticate(tokens[1]!, 'worker')).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
  }, 60000)

  it('isolates a waiting branch while its sibling finishes and consumes each exact response once', async () => {
    const f = await fixture(), { compare } = await graphParity(f.db.pool, f.f.scope)
    await f.engine.start(f.f.run.id)
    const [first, sibling] = await f.pending()
    if (!first || !sibling) throw new Error('Expected parallel native requests')
    await f.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(first))
    expect((await compare()).state.run.pendingInteractionCount).toBe(1)
    expect((await f.repository.get(sibling.id))?.status).toBe('pending')
    const completed = await f.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(sibling))
    expect((await compare()).state.run.outcome).toBe('succeeded')
    const receipts = await f.receipts()
    expect(receipts).toHaveLength(2)
    await f.engine.resumeInteraction(completed.interaction)
    await compare()
    expect(await f.receipts()).toEqual(receipts)
    expect(f.provider.counts).toMatchObject({ sessions: 3, starts: 3, responses: 2 })
  }, 60000)
})
