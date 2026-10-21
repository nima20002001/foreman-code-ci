import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { approvalAtomicSetup, decision } from './helpers/approvalAtomic.js'

const setup = approvalAtomicSetup()

describe.skipIf(!postgresEnabled)('approval ownership', { timeout: 60000 }, () => {
  it('Stop blocks decisions and records cleanup without Worker continuation', async () => {
    const f = await setup()
    await f.stop()
    await expect(decision(f)).rejects.toBeDefined()
    expect(await f.repository.delivery.claim(f.interaction.id, 'after-stop')).toBeUndefined()
    expect((await f.pool.query('select stop_requested_at from runs where id=$1', [f.run.id])).rows[0].stop_requested_at).not.toBeNull()
    expect((await f.pool.query('select pending from run_cleanup_intents where run_id=$1', [f.run.id])).rows[0].pending).toBe(true)
    expect(f.counts().responses).toBe(0)
  })

  it('changed native generation fences the acknowledged reviewer credential', async () => {
    const f = await setup()
    await f.pool.query("update native_session_lanes set record=jsonb_set(record,'{connectionGeneration}',to_jsonb((record->>'connectionGeneration')::integer+1)) where owner_agent_id=$1", [f.reviewer.agentId])
    await expect(decision(f)).rejects.toBeDefined()
    expect((await f.repository.get(f.interaction.id))?.status).toBe('pending')
  })

  it('expired review ownership cannot decide under its previously issued credential', async () => {
    const f = await setup()
    await f.pool.query("update review_jobs set record=jsonb_set(record,'{leaseExpiresAt}',to_jsonb('2000-01-01T00:00:00.000Z'::text)),lease_expires_at='2000-01-01' where id=$1", [f.job.id])
    await expect(decision(f)).rejects.toBeDefined()
    expect(f.counts().responses).toBe(0)
  })
})
