import { useEffect } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SendOperatorMessageRequestSchema, SendOperatorMessageResponseSchema,
  type OperatorConversationState, type SendOperatorMessageRequest,
} from '@foreman-code/contracts'
import { FileWithRevisionSchema, type FileWithRevision, type TemporaryFileScope } from '@foreman-code/contracts/files'
import { server } from '../../mocks/server'
import { sendOperatorMessage } from '../../shared/api/client'
import { protectedKey } from '../../shared/api/protectedChatStorage'
import { AttachmentDraftProvider } from '../attachments/AttachmentDraftProvider'
import type { AttachmentClient } from '../attachments/attachmentClient'
import { useConversationAttachments, type ConversationAttachments } from '../attachments/useConversationAttachments'
import { prepareChatAttachments } from '../conversations/chatAttachmentAttempt'
import {
  acknowledgeOperatorMessage, beginOperatorMessageAttempt, readPendingOperatorMessage,
  recordOperatorMessageFailure, reserveOperatorMessage,
} from './operatorOutbox'
import { useOperatorAttachmentReceipts } from './useOperatorAttachmentReceipts'

const scope = (conversationId: string): TemporaryFileScope => ({ kind: 'temporary', chat: {
  kind: 'operator', ownerPrincipalId: 'owner-a', operatorId: 'operator-a', conversationId,
} })
const selectedScope = scope('chat-a')
const otherScope = scope('chat-other')
interface Tab {
  draft: ConversationAttachments
  other: ConversationAttachments
  receipts: ReturnType<typeof useOperatorAttachmentReceipts>
}
let tabs: Map<string, Tab>
let clients: QueryClient[]
let files: Map<string, FileWithRevision>
let requests: SendOperatorMessageRequest[]
let accepted: OperatorConversationState
let upload: ReturnType<typeof vi.fn<AttachmentClient['upload']>>
let cancel: ReturnType<typeof vi.fn<AttachmentClient['cancel']>>
let release: () => void
let gate: Promise<void>
let gateReceipt: boolean
let malformedReceipt: boolean
let locks: PropertyDescriptor | undefined
function Probe({ name }: { name: string }) {
  const draft = useConversationAttachments(selectedScope)
  const other = useConversationAttachments(otherScope)
  const receipts = useOperatorAttachmentReceipts()
  useEffect(() => { tabs.set(name, { draft, other, receipts }) }, [name, draft, other, receipts])
  return <span>{name}</span>
}
function mountTab(name: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><AttachmentDraftProvider client={{ upload, cancel }}>
    <Probe name={name} />
  </AttachmentDraftProvider></QueryClientProvider>)
  return () => tabs.get(name)!
}
async function add(tab: () => Tab, name: string, other = false) {
  const before = (other ? tab().other : tab().draft).items.length
  act(() => (other ? tab().other : tab().draft).addFiles([new File([name], name, { type: 'text/markdown' })]))
  await waitFor(() => expect((other ? tab().other : tab().draft).readyRefs).toHaveLength(before + 1))
}
beforeEach(() => {
  tabs = new Map(); clients = []; files = new Map(); requests = []
  gateReceipt = false; malformedReceipt = false
  gate = new Promise<void>((resolve) => { release = resolve })
  window.localStorage.clear()
  locks = Object.getOwnPropertyDescriptor(navigator, 'locks')
  // A shared, serialized Web Locks test double; production still requires Web Locks.
  let tail = Promise.resolve()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request: (_name: string, options: LockOptions, work: (lock: Lock) => unknown) => {
      const result = tail.then(() => {
        options.signal?.throwIfAborted()
        return work({ name: 'graphql.operator-outbox.v1', mode: 'exclusive' })
      })
      tail = result.then(() => undefined, () => undefined)
      return result
    },
  } })
  upload = vi.fn<AttachmentClient['upload']>(async (input) => {
    const createdAt = new Date().toISOString()
    const row = FileWithRevisionSchema.parse({
      file: { fileId: `file-${input.requestId}`, currentRevisionId: `revision-${input.requestId}`, scope: input.scope,
        state: 'ready', createdAt, retentionDurationSeconds: 3600,
        expiresAt: new Date(Date.parse(createdAt) + 3_600_000).toISOString() },
      revision: { fileId: `file-${input.requestId}`, revisionId: `revision-${input.requestId}`, filename: input.filename,
        mediaType: input.mediaType, byteSize: input.file.size, sha256: 'a'.repeat(64), origin: 'upload', createdAt },
    })
    files.set(row.file.fileId, row)
    return row
  })
  cancel = vi.fn<AttachmentClient['cancel']>().mockResolvedValue(undefined)
  server.use(http.post('/api/operator/conversations/chat-a/messages', async ({ request }) => {
    const command = SendOperatorMessageRequestSchema.parse(await request.json())
    requests.push(command)
    if (!command.recovery) {
      accepted = SendOperatorMessageResponseSchema.parse({ replayed: false, state: {
        conversation: { id: 'chat-a', scope: 'application', agentId: 'operator-a', operatorConfigurationVersionId: 'configuration-a' },
        messages: [{ id: 'accepted-message', conversationId: 'chat-a', requestId: command.requestId,
          role: 'user', content: command.content, attachments: command.attachments.map((pin) => files.get(pin.fileId)!) }],
        turnState: 'idle', revision: 2,
      } }).state
      return HttpResponse.error() // Durable admission succeeded; only the response is lost.
    }
    if (gateReceipt) await gate
    return HttpResponse.json({ replayed: true, state: malformedReceipt ? {
      ...accepted, messages: accepted.messages.map((message) => ({ ...message,
        // A publication alone must not confirm the missing input revision.
        attachments: message.attachments?.slice(1) ?? [],
      })),
    } : accepted })
  }))
})
afterEach(async () => {
  release(); cleanup()
  await act(async () => { await Promise.resolve() })
  for (const client of clients) client.clear()
  window.localStorage.clear()
  if (locks) Object.defineProperty(navigator, 'locks', locks)
  else Reflect.deleteProperty(navigator, 'locks')
})
async function loseSend(tab: () => Tab) {
  await add(tab, 'sent.md')
  const attachment = prepareChatAttachments(tab().draft)!
  const command = await reserveOperatorMessage('chat-a', 'first message', '/', undefined, undefined, undefined, attachment.attachments)
  act(() => tab().receipts.remember('chat-a', command, attachment))
  const attemptId = await beginOperatorMessageAttempt('chat-a', command)
  await expect(sendOperatorMessage('chat-a', command)).rejects.toThrow()
  await recordOperatorMessageFailure('chat-a', command.requestId, 'Lost response', false, attemptId)
  return command
}
async function recoverInOtherTab(tab: () => Tab) {
  const command = readPendingOperatorMessage('chat-a').command!
  await beginOperatorMessageAttempt('chat-a', command)
  const result = await sendOperatorMessage('chat-a', { ...command, recovery: 'receipt' })
  act(() => tab().receipts.confirm(command.requestId, result.state))
  expect(await acknowledgeOperatorMessage('chat-a', command.requestId)).toBe(true)
  return result
}
function publishOutput() {
  const source = accepted.messages[0].attachments![0]
  const output = FileWithRevisionSchema.parse({
    file: { ...source.file, fileId: 'published-output', currentRevisionId: 'published-revision' },
    revision: { ...source.revision, fileId: 'published-output', revisionId: 'published-revision',
      filename: 'result.md', origin: 'agent_output' },
  })
  accepted = { ...accepted, revision: accepted.revision + 1,
    messages: accepted.messages.map((message) => ({ ...message, attachments: [...(message.attachments ?? []), output] })),
  }
}
function storageEvent() {
  window.dispatchEvent(new StorageEvent('storage', { key: protectedKey('outbox', 'chat-a'), newValue: null }))
}

describe('ATT-02: separate attachment providers sharing an Operator outbox', () => {
  it.each([
    ['storage', false], ['storage-and-late', false], ['late-only', false],
    ['storage', true], ['storage-and-late', true], ['late-only', true],
  ] as const)(
    'clears only A’s accepted selections after recovery in B (%s; R2-6 published output: %s)', async (delivery, published) => {
      const a = mountTab('A')
      const b = mountTab('B')
      const command = await loseSend(a)
      if (published) publishOutput()
      await add(a, 'keep.md') // Added after the accepted snapshot: must not be consumed.
      await add(a, 'other.md', true)
      await add(b, 'tab-b.md')
      const keep = a().draft.readyRefs[1]
      const other = a().other.readyRefs
      const bPins = b().draft.readyRefs
      const result = await recoverInOtherTab(b)
      expect(readPendingOperatorMessage('chat-a').command).toBeUndefined()
      expect(a().draft.readyRefs).toHaveLength(2)
      expect(b().draft.readyRefs).toEqual(bPins)
      gateReceipt = true
      if (delivery !== 'late-only') {
        act(storageEvent)
        await waitFor(() => expect(requests).toHaveLength(3))
        expect(requests[2]).toMatchObject({ ...command, recovery: 'receipt' })
        // Outbox removal alone cannot acknowledge a file or enable its reuse.
        expect(a().receipts.blocksSend('chat-a', a().draft.readyRefs)).toBe(true)
        expect(a().draft.readyRefs).toHaveLength(2)
        release()
      } else {
        expect(await acknowledgeOperatorMessage('chat-a', command.requestId)).toBe(false)
        act(() => a().receipts.confirm(command.requestId, result.state))
      }
      await waitFor(() => expect(a().draft.readyRefs).toEqual([keep]))
      expect(a().other.readyRefs).toEqual(other)
      expect(b().draft.readyRefs).toEqual(bPins)
      expect(a().receipts.blocksSend('chat-a', a().draft.readyRefs)).toBe(false)
      const next = await reserveOperatorMessage('chat-a', 'next message', '/', undefined, undefined, undefined,
        prepareChatAttachments(a().draft)!.attachments)
      expect(next.requestId).not.toBe(command.requestId)
      expect(next.attachments).toEqual([keep])
      if (delivery === 'storage-and-late') {
        expect(await acknowledgeOperatorMessage('chat-a', command.requestId)).toBe(false)
        act(() => a().receipts.confirm(command.requestId, result.state))
        expect(a().draft.readyRefs).toEqual([keep])
        expect(readPendingOperatorMessage('chat-a').command?.requestId).toBe(next.requestId)
      }
      expect(cancel).not.toHaveBeenCalled()
      expect(upload).toHaveBeenCalledTimes(4)
      expect(requests.filter((request) => !request.recovery)).toHaveLength(1)
    },
  )

  it.each([false, true])('keeps the draft when the receipt lacks its input (R2-6 published output: %s)', async (published) => {
    const a = mountTab('A')
    const b = mountTab('B')
    const command = await loseSend(a)
    if (published) publishOutput()
    await recoverInOtherTab(b)
    malformedReceipt = true
    act(storageEvent)
    await waitFor(() => { expect(requests).toHaveLength(3); expect(clients[0].isFetching()).toBe(0) })
    expect(a().draft.readyRefs).toEqual(command.attachments)
    expect(a().receipts.blocksSend('chat-a', a().draft.readyRefs)).toBe(true)
    malformedReceipt = false
    act(() => a().receipts.reconcile())
    await waitFor(() => expect(a().draft.hasAttachments).toBe(false))
    expect(upload).toHaveBeenCalledTimes(1)
    expect(cancel).not.toHaveBeenCalled()
    expect(requests.filter((request) => !request.recovery)).toHaveLength(1)
  })
})
