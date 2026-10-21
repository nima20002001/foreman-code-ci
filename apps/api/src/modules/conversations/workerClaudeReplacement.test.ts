import { expect, it, vi } from 'vitest'
import { SessionPreferencesSchema } from '@foreman-code/contracts'
import { workerClaudeReplacementFixture } from './workerClaudeReplacement.test-support.js'

it('keeps history, message, cancel and close usable after a remote preferences replacement', async () => {
  const f = await workerClaudeReplacementFixture()
  try {
    const session = await f.send('initial')
    const previous = (await f.journal.conversations.read(f.binding))!.nativeOwner
    f.holdResume()
    const applying = f.manager.applySessionPreferences(session, SessionPreferencesSchema.parse({ autoCompact: 'off' }))
    await vi.waitFor(() => expect(f.hasResumeWaiter()).toBe(true))
    let readFinished = false
    const reading = f.manager.history(session).then(value => { readFinished = true; return value })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(readFinished).toBe(false)
    f.releaseResume()
    await applying
    await reading
    const changed = (await f.journal.conversations.read(f.binding))!
    expect(changed.nativeOwner).not.toEqual(previous)
    expect(changed.ownerTransitions).toEqual([{ previous, next: changed.nativeOwner }])
    expect(changed.session).toEqual(session)
    expect(await f.send('after-preferences')).toEqual(session)
    expect(await f.manager.cancel(session)).toBe(false)
    await f.manager.close(session)
    expect((await f.journal.conversations.read(f.binding))?.closed).toBe(true)
    expect(f.resumes).toEqual([undefined, session.nativeSessionId])
  } finally { await f.close() }
})

it('settles definite remote non-delivery on Main and admits another message on the same session', async () => {
  const f = await workerClaudeReplacementFixture()
  try {
    const session = await f.send('initial')
    f.failMode()
    await expect(f.send('not-offered')).rejects.toMatchObject({ certainty: 'definite', deliveryState: 'not-delivered' })
    expect(f.offers).toHaveLength(1)
    expect((await f.manager.reconcile(session, 'not-offered')).nonSubmission).toMatchObject({
      nativeSessionId: session.nativeSessionId, clientCorrelationId: 'not-offered', result: { outcome: 'failed' },
    })
    await expect(f.send('not-offered')).rejects.toMatchObject({ certainty: 'definite' })
    expect(await f.send('later')).toEqual(session)
    expect(f.offers).toHaveLength(2)
  } finally { await f.close() }
})

it('reports initial SDK startup non-delivery and allows a new initial request', async () => {
  const f = await workerClaudeReplacementFixture()
  try {
    f.failStartup()
    await expect(f.send('failed-initial')).rejects.toMatchObject({ certainty: 'definite', deliveryState: 'not-delivered' })
    expect((await f.journal.conversations.read(f.binding))?.creation?.status).toBe('rejected')
    expect(f.offers).toHaveLength(0)
    await expect(f.send('failed-initial')).rejects.toMatchObject({ certainty: 'definite' })
    await f.send('recovered-initial')
    expect(f.offers).toHaveLength(1)
    expect(f.resumes).toEqual([undefined])
  } finally { await f.close() }
})

it('rejects an ownership replacement without confirmed old-process closure', async () => {
  const f = await workerClaudeReplacementFixture()
  try {
    const session = await f.send('initial')
    const previous = (await f.journal.conversations.read(f.binding))!.nativeOwner
    f.unconfirmedClosure()
    await expect(f.manager.applySessionPreferences(session, SessionPreferencesSchema.parse({ autoCompact: 'off' })))
      .rejects.toThrow('unavailable or changed')
    expect((await f.journal.conversations.read(f.binding))?.nativeOwner).toEqual(previous)
    expect(f.offers).toHaveLength(1)
  } finally { await f.close() }
})

it('detaches an observer after a rejected owner change without retrying process closure', async () => {
  const f = await workerClaudeReplacementFixture()
  try {
    const session = await f.send('initial')
    f.unconfirmedClosure()
    await expect(f.manager.applySessionPreferences(session, SessionPreferencesSchema.parse({ autoCompact: 'off' })))
      .rejects.toMatchObject({ code: 'WORKER_CONVERSATION_UNAVAILABLE' })
    const before = await f.journal.conversations.read(f.binding)
    await expect(f.manager.dispose()).resolves.toBeUndefined()
    expect(await f.journal.conversations.read(f.binding)).toEqual(before)
    expect(f.resumes).toHaveLength(2)
    expect(f.offers).toHaveLength(1)
  } finally { await f.close() }
})

it('updates ownership before delivering a message with changed next-turn preferences', async () => {
  const f = await workerClaudeReplacementFixture()
  try {
    const session = await f.send('initial')
    const previous = (await f.journal.conversations.read(f.binding))!.nativeOwner
    const submitted = vi.fn(async () => {
      expect((await f.journal.conversations.read(f.binding))!.nativeOwner).not.toEqual(previous)
    })
    const stream = f.manager.startTurn(session, { prompt: 'Changed preferences', clientCorrelationId: 'next-preferences',
      sessionPreferences: SessionPreferencesSchema.parse({ autoCompact: 'off' }), onMessageSubmitted: submitted })
    for await (const event of stream) void event
    expect(submitted).toHaveBeenCalledOnce()
    expect((await f.manager.reconcile(session, 'next-preferences')).terminalResult?.outcome).toBe('succeeded')
    expect(f.resumes).toEqual([undefined, session.nativeSessionId])
    expect(f.offers).toHaveLength(2)
  } finally { await f.close() }
})
