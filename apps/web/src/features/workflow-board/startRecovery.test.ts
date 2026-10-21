import { beforeEach, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { RunStartV3InputSchema } from '@foreman-code/contracts/wave25'
import { nextDraftKey } from '../graph/nextDraft/state'
import { boardV3Fixture } from './v3Fixture.testSupport'
import { boardStartJournalKey, readBoardStart, reserveBoardStart } from './startOutbox'
import { recoverBoardStart } from './startRecovery'

const fixture = boardV3Fixture()
const request = RunStartV3InputSchema.parse({ workspaceId: fixture.scope.workspaceId,
  workflowId: fixture.scope.workflowId, workflowVersionId: fixture.scope.workflowVersionId, executionSemanticsVersion: 3,
  expectedWorkflowRevision: 7, expectedAgentConfigurationVersionIds: fixture.version.agentConfigurationVersionIds,
  expectedLocationRevision: fixture.run.executionLocation?.locationRevision,
  commandId: 'fde92986-fcb2-4d2e-8e6c-0ddc2141efbf', input: fixture.run.input })
const key = nextDraftKey(request.workspaceId, request.workflowId)
const path = '*/api/management/workspaces/:workspaceId/workflows/:workflowId/runs/start-resolution'

beforeEach(() => {
  localStorage.clear()
  Object.defineProperty(navigator, 'locks', { configurable: true,
    value: { request: async (_key: string, callback: () => unknown) => callback() } })
})

it('clears a restored journal only after the server cancels that Start command', async () => {
  await reserveBoardStart(key, request)
  const restored = JSON.parse(localStorage.getItem(boardStartJournalKey(key))!)
  server.use(http.post(path, async ({ request: httpRequest }) => {
    expect(await httpRequest.json()).toEqual(request)
    return HttpResponse.json({ status: 'canceled' })
  }))
  expect(await recoverBoardStart(key, restored)).toMatchObject({ result: { status: 'canceled' }, acknowledgement: 'removed' })
  expect(readBoardStart(key)).toBeUndefined()
})

it('returns the original accepted Run after a lost reply without issuing another Start', async () => {
  await reserveBoardStart(key, request)
  server.use(http.post(path, () => HttpResponse.json({ status: 'accepted', run: fixture.run })))
  expect(await recoverBoardStart(key, request)).toMatchObject({ result: { status: 'accepted', run: { id: fixture.run.id } } })
  expect(readBoardStart(key)).toBeUndefined()
})

it('retains the journal when cancellation itself has an unknown outcome', async () => {
  await reserveBoardStart(key, request)
  server.use(http.post(path, () => HttpResponse.error()))
  await expect(recoverBoardStart(key, request)).rejects.toThrow()
  expect(readBoardStart(key)).toEqual(request)
})
