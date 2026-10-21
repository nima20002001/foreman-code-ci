import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { WorkflowChatPostRequestSchema } from '@foreman-code/contracts'
import { server } from '../../mocks/server'
import { installBoardTestLifecycle, mountMeasuredBoard } from './eng05D.testSupport'
import { inspectionBoardFixture } from './inspect/inspectionFixtures'

installBoardTestLifecycle()

it('opens the Group panel on the Board, posts exact text and retains its selection in navigation', async () => {
  const fixture = await inspectionBoardFixture('group-panel')
  const { workspaceId, workflowId } = fixture.runs.before.scope
  const root = `/api/workspaces/${workspaceId}/workflows/${workflowId}/chat`
  const bodies: string[] = []
  server.use(...fixture.mock.handlers,
    http.get(root, () => HttpResponse.json({ items: [], nextCursor: null, hasMore: false, revision: 0 })),
    http.get(`${root}/deliveries`, () => HttpResponse.json({ items: [], nextCursor: null, hasMore: false, revision: 0 })),
    http.post(`${root}/posts`, async ({ request }) => {
      const input = WorkflowChatPostRequestSchema.parse(await request.json())
      bodies.push(input.body)
      return HttpResponse.json({ post: { id: 'posted-message', channelId: 'channel', sequence: 1,
        workspaceId, workflowId, author: { kind: 'user', principalId: 'human', displayName: 'You' },
        kind: 'message', body: input.body, mentions: [], cardIds: [], createdAt: '2026-10-01T00:00:00Z' },
      receipts: [], replayed: false })
    }),
  )
  const user = userEvent.setup()
  const { router } = await mountMeasuredBoard(`/workspaces/${workspaceId}?workflowId=${workflowId}`)
  await user.click(await screen.findByRole('button', { name: 'Group chat' }))
  const panel = await screen.findByRole('region', { name: 'Group chat' })
  const composer = within(panel).getByRole('combobox', { name: 'Message this workflow' })
  await user.type(composer, '  Board conversation  ')
  await user.click(within(panel).getByRole('button', { name: 'Post' }))
  await screen.findByRole('complementary', { name: 'Selected post' })
  expect(bodies).toEqual(['  Board conversation  '])
  expect(router.state.location.search.groupPostId).toBe('posted-message')
})
