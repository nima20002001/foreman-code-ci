// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from '../../shared/api/client'
import { currentWorkflowFixture } from '../../shared/mocks/currentWorkflow'
import { boardStopKey, clearBoardStopStorage, createBoardStopClient, readBoardStop, recordBoardStopReceipt,
  reserveBoardStop, settleBoardStop, type BoardStopJournal } from './stopOutbox'
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const scope = () => currentWorkflowFixture('stop-current').scope
beforeEach(() => {
  localStorage.clear(); clearBoardStopStorage()
  let queue: Promise<unknown> = Promise.resolve()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (_: string, work: () => unknown) => {
    const result = queue.then(work); queue = result.catch(() => undefined); return result
  } } })
})
afterEach(() => { vi.restoreAllMocks(); clearBoardStopStorage() })
describe('current selected-Run Stop: exact durable command and truthful settlement', () => {
  it('reuses the first command across concurrent reservations and lost replies', async () => {
    const selected = scope(), [first, second] = await Promise.all([reserveBoardStop(selected), reserveBoardStop(selected)])
    expect(first).toEqual(second)
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValueOnce(new TypeError('Lost response'))
      .mockResolvedValue(response({ runId: selected.runId, status: 'accepted', processStopped: false, replayed: true }))
    const send = createBoardStopClient(new ApiClient({ fetch }))
    await expect(send(first)).rejects.toThrow()
    expect(readBoardStop(selected)).toEqual(first)
    const receipt = await send((await reserveBoardStop(selected)))
    await recordBoardStopReceipt(first, receipt)
    expect(fetch.mock.calls[1]![1]?.body).toEqual(fetch.mock.calls[0]![1]?.body)
    expect(fetch.mock.calls[1]![1]?.credentials).toBe('omit')
    expect(readBoardStop(selected)?.receipt?.status).toBe('accepted')
    // An ACK is deliberately not settlement; only the caller's exact canonical
    // terminal + cleanup-false readback may invoke settleBoardStop.
    expect(readBoardStop(selected)).toBeDefined()
    await settleBoardStop(selected, first.request)
    expect(readBoardStop(selected)).toBeUndefined()
  })
  it.each([403, 409])('retains the exact command after denial or stale service failure (%i)', async (status) => {
    const selected = scope(), journal = await reserveBoardStop(selected)
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ error: { code: status === 403 ? 'FORBIDDEN' : 'REVISION_CONFLICT', message: 'No work acknowledged' } }, status))
    await expect(createBoardStopClient(new ApiClient({ fetch }))(journal)).rejects.toMatchObject({ status })
    expect(readBoardStop(selected)).toEqual(journal)
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('does not turn not-owner or missing native closure into successful settlement', async () => {
    const selected = scope(), journal = await reserveBoardStop(selected)
    await recordBoardStopReceipt(journal, { runId: selected.runId, status: 'not_owner', processStopped: false, replayed: false })
    await expect(settleBoardStop(selected, journal.request)).rejects.toThrow()
    expect(readBoardStop(selected)?.receipt?.status).toBe('not_owner')
  })
  it('refuses wrong-Run receipts and changed command payloads', async () => {
    const selected = scope(), journal = await reserveBoardStop(selected)
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ runId: 'wrong-run', status: 'accepted', processStopped: false, replayed: false }))
    await expect(createBoardStopClient(new ApiClient({ fetch }))(journal)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    await expect(recordBoardStopReceipt({ ...journal, request: { ...journal.request, commandId: 'different-command' } },
      { runId: selected.runId, status: 'accepted', processStopped: false, replayed: false })).rejects.toThrow()
    expect(readBoardStop(selected)).toEqual(journal)
  })
  it.each([1, 2, 99, undefined])('rejects retired/missing execution scope %s before HTTP', async (tag) => {
    const selected = scope(), journal = await reserveBoardStop(selected)
    const invalid = { ...journal, scope: { ...selected, executionSemanticsVersion: tag } }
    const fetch = vi.fn<typeof globalThis.fetch>()
    await expect(createBoardStopClient(new ApiClient({ fetch }))(invalid as unknown as BoardStopJournal)).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
    localStorage.setItem(boardStopKey(selected), JSON.stringify(invalid))
    await expect(reserveBoardStop(selected)).rejects.toThrow()
    expect(localStorage.getItem(boardStopKey(selected))).toBe(JSON.stringify(invalid))
  })
})
