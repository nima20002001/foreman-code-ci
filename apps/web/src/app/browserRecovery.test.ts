import { expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../mocks/server'
import { browserSessionClient, returnBrowserControl } from './browserRecovery'
import type { BrowserSession } from '../features/agent-browser/types'

it('joins shell navigation and panel cleanup into one acknowledged control return', async () => {
  const session: BrowserSession = { id: 'browser', profileId: 'profile', setupForProfileId: 'profile', computerId: 'computer',
    browserGeneration: 1, state: 'ready', selectedTabId: null }
  const commands: string[] = []
  const returned = { sessionId: session.id, state: 'paused', epoch: 2, controllingViewerId: null, reason: 'Browser ready for setup.' }
  server.use(
    http.post('/api/browser/sessions/browser/control/acquire', () => HttpResponse.json({ ...returned, state: 'user', epoch: 1, controllingViewerId: 'viewer' })),
    http.post('/api/browser/sessions/browser/control/release', async ({ request }) => {
      const input = await request.json() as { commandId: string }
      commands.push(input.commandId)
      return HttpResponse.json(returned)
    }),
  )
  await browserSessionClient.acquire(session, 'viewer', 'acquire')
  const navigation = returnBrowserControl()
  const disposal = browserSessionClient.release(session, 'viewer', 1, 'panel-cleanup')
  await navigation
  expect(await disposal).toEqual(returned)
  expect(commands).toHaveLength(1)
})
