import { expect, it } from 'vitest'
import { fixture } from './helpers/agentChatF1.js'

it('rejects a new message when its workspace was archived after chat resolution', async () => {
  const f = fixture()
  f.store.workspaceArchived = true
  try {
    await expect(f.send('late-message')).rejects.toMatchObject({ code: 'WORKSPACE_ARCHIVED' })
    expect(f.store.turns.size).toBe(0)
    expect(f.manager.starts).toEqual([])
  } finally { await f.service.shutdown() }
})

it('keeps an accepted message replay readable after workspace archive', async () => {
  const f = fixture()
  try {
    await f.send('accepted-message')
    await f.idle()
    f.store.workspaceArchived = true
    expect((await f.send('accepted-message')).replayed).toBe(true)
    expect(f.manager.starts).toEqual(['accepted-message'])
  } finally { await f.service.shutdown() }
})
