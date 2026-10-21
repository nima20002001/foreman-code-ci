import { expect, it } from 'vitest'
import { workerClaudeReplacementFixture } from '../src/modules/conversations/workerClaudeReplacement.test-support.js'

it('resumes the remote session after 256 native inputs including compaction', async () => {
  const f = await workerClaudeReplacementFixture()
  try {
    const session = await f.send('initial')
    await f.manager.compactSession(session, { requestId: 'manual-compact', clientCorrelationId: 'compact-input',
      onProgress: async () => {} })
    for (let index = 1; index < 255; index++) await f.send(`input-${index}`)
    expect(f.offers).toHaveLength(256)
    expect(f.resumes).toHaveLength(1)
    expect(await f.send('rollover')).toEqual(session)
    expect(f.resumes).toEqual([undefined, session.nativeSessionId])
    expect(f.offers).toHaveLength(257)
    expect(new Set(f.offers.map(message => message.uuid)).size).toBe(257)
    expect((await f.journal.conversations.read(f.binding))?.ownerTransitions).toHaveLength(1)
    await expect(f.manager.history(session)).resolves.toMatchObject({ pendingInteractions: [] })
  } finally { await f.close() }
}, 180_000)
