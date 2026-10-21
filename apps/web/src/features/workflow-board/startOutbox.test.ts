import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../shared/api/client'
import { nextDraftKey } from '../graph/nextDraft/state'
import { parseBoardStart } from './startClient'
import { acknowledgeBoardStart, boardStartJournalKey, readBoardStart, rejectBoardStart, reserveBoardStart } from './startOutbox'

const key = nextDraftKey('ws-start', 'wf-start')
const previousPins = () => parseBoardStart({ executionSemanticsVersion: 3, workspaceId: 'ws-start', workflowId: 'wf-start',
  workflowVersionId: 'version-two', expectedWorkflowRevision: 7, expectedAgentConfigurationVersionIds: { agent: 'config-two' }, draftId: 'draft-two', expectedDraftRevision: 7, expectedLocationRevision: 9,
  commandId: '6f4d5c31-1316-4bed-99b6-cb78dd3bd6db', input: {} })
const v3 = () => parseBoardStart({ executionSemanticsVersion: 3, workspaceId: 'ws-start', workflowId: 'wf-start',
  workflowVersionId: 'version-three', expectedWorkflowRevision: 8, expectedAgentConfigurationVersionIds: { agent: 'config-three' },
  expectedLocationRevision: 10, commandId: '09f41f9a-9e19-412c-a25f-7f951a4a44a0', input: {} })

beforeEach(() => {
  window.localStorage.clear()
  let tail: Promise<unknown> = Promise.resolve()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: vi.fn((_name: string, work: () => unknown) => {
    const next = tail.then(work); tail = next.catch(() => undefined); return next
  }) } })
})

describe('one durable journal for exact current V3 Start replay', () => {
  it('reconciles earlier saved V3 pins byte-for-byte instead of replacing them with the moving head', async () => {
    const old = JSON.stringify(previousPins())
    window.localStorage.setItem(boardStartJournalKey(key), old)
    expect(await reserveBoardStart(key, v3())).toEqual(previousPins())
    expect(window.localStorage.getItem(boardStartJournalKey(key))).toBe(old)
  })
  it('makes concurrent reservations return the same first command', async () => {
    const [first, second] = await Promise.all([reserveBoardStart(key, v3()), reserveBoardStart(key, previousPins())])
    expect(first).toEqual(v3()); expect(second).toEqual(first)
    expect(navigator.locks.request).toHaveBeenCalledWith(boardStartJournalKey(key), expect.any(Function))
  })
  it('acknowledges both tabs after they reserved the same accepted command', async () => {
    const [first, second] = await Promise.all([reserveBoardStart(key, v3()), reserveBoardStart(key, previousPins())])
    expect(await acknowledgeBoardStart(key, first)).toBe('removed')
    expect(await acknowledgeBoardStart(key, second)).toBe('absent')
    expect(readBoardStart(key)).toBeUndefined()
  })
  it('reports an older accepted command as superseded without removing a newer reservation', async () => {
    const first = await reserveBoardStart(key, previousPins())
    await acknowledgeBoardStart(key, first)
    const newer = await reserveBoardStart(key, v3())
    expect(await acknowledgeBoardStart(key, first)).toBe('superseded')
    expect(readBoardStart(key)).toEqual(newer)
  })
  it('does not clear the journal for a different payload with the same command ID', async () => {
    const request = await reserveBoardStart(key, v3())
    await expect(acknowledgeBoardStart(key, { ...request, workflowVersionId: 'moving-head' })).rejects.toThrow()
    expect(readBoardStart(key)).toEqual(request)
    await acknowledgeBoardStart(key, request)
    expect(readBoardStart(key)).toBeUndefined()
  })
  it.each(['{bad-json', JSON.stringify({ ...v3(), executionSemanticsVersion: 1 }), JSON.stringify({ ...v3(), executionSemanticsVersion: 2 }), JSON.stringify({ ...v3(), executionSemanticsVersion: 4 }), JSON.stringify({ ...v3(), workspaceId: 'other' })])(
    'retains an invalid/out-of-scope journal and refuses a replacement', async (raw) => {
      window.localStorage.setItem(boardStartJournalKey(key), raw)
      await expect(reserveBoardStart(key, previousPins())).rejects.toThrow()
      expect(window.localStorage.getItem(boardStartJournalKey(key))).toBe(raw)
    })
  it('fails closed without Web Locks or durable storage', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })
    await expect(reserveBoardStart(key, v3())).rejects.toThrow(/cross-tab/)
    expect(readBoardStart(key)).toBeUndefined()
  })
  it('retains V3 across denial, stale pins and uncertain server errors', async () => {
    const request = await reserveBoardStart(key, v3())
    for (const error of [new ApiError({ code: 'FORBIDDEN', message: 'denied' }, 403),
      new ApiError({ code: 'REVISION_CONFLICT', message: 'stale' }, 409),
      new ApiError({ code: 'WORKFLOW_VERSION_UNSUPPORTED', message: 'uncertain server failure' }, 500)]) {
      expect(await rejectBoardStart(key, request, error)).toBe(false)
      expect(readBoardStart(key)).toEqual(request)
    }
  })
  it('releases only the exact explicitly rejected current command', async () => {
    const request = await reserveBoardStart(key, previousPins())
    expect(await rejectBoardStart(key, request, new ApiError({ code: 'WORKFLOW_VERSION_UNSUPPORTED', message: 'unsupported' }, 409))).toBe(true)
    expect(readBoardStart(key)).toBeUndefined()
  })
})
