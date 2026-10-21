import { installCanonicalOperatorFixture } from '../operator-chat/canonicalOperator.test-support'
import { webcrypto } from 'node:crypto'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import {
  DEFAULT_AGENT_DEFAULTS, DEFAULT_HARNESS_DEFAULTS, SendOperatorMessageRequestSchema,
  type Message, type OperatorConversationState, type SendOperatorMessageRequest,
} from '@foreman-code/contracts'
import {
  agentChatFixtures, SendAgentChatMessageRequestSchema, SendAgentChatMessageResponseSchema,
  type AgentChatState, type AgentChatTurn, type SendAgentChatMessageRequest,
} from '@foreman-code/contracts/agent-chat'
import {
  DEFAULT_FILE_RETENTION_SECONDS, FileWithRevisionSchema, temporaryFileExpiresAt,
  type FileMediaType, type FileWithRevision, type TemporaryFileScope,
} from '@foreman-code/contracts/files'
import { server } from '../../mocks/server'
import { useLocalHumanAccessQuery } from '../../shared/api/settingsExperience'
import { identityEpoch } from '../../shared/api/protectedChatStorage'
import { agentChatFixtureFor, createAgentChatMock } from '../../shared/mocks/agentChatHandlers'
import { OperatorChat } from '../operator-chat/OperatorChat'
import { OperatorComposer } from '../operator-chat/OperatorComposer'
import { OperatorMessages } from '../operator-chat/OperatorMessages'
import { OperatorChatVisibilityProvider } from '../operator-chat/visibility'
import { configuredOperatorSetup } from '../operator-chat/operatorSetupTestFixture'
import { useOperatorChatStore } from '../operator-chat/operatorChatStore'
import { operatorState } from '../operator-chat/pr17-test-fixtures'
import { readPendingOperatorMessage } from '../operator-chat/operatorOutbox'
import { summarizeOperatorConversation } from '../operator-chat/operatorChatStatus'
import { clearRevisionedFormPersistence } from '../settings/revisionedForm'
import { AgentChatPanel } from '../graph/AgentPanels'
import { installChatSource } from './agentChat/testSupport'
import { agentChatStateKey } from './agentChat/useAgentChat'
import { useConversationDraftStore } from './conversationDraftStore'
import { ChatAttachmentBoundary } from './ChatAttachmentBoundary'
import { ConversationComposer } from './ConversationComposer'
import { messageAttachmentRefs } from './chatAttachmentAttempt'

// Only unrelated settings popovers and the live wire are replaced. The real composers,
// transcripts, uploads (including XHR), outbox and JSON clients run through MSW.
vi.mock('../operator-chat/OperatorComposerSettings', () => ({ OperatorComposerSettings: () => null }))
vi.mock('../operator-chat/OperatorAccessPicker', () => ({ OperatorAccessPicker: () => null }))
vi.mock('../../shared/api/operatorChatStream', () => ({ subscribeOperatorChat: () => () => {} }))

const owner = 'fil13-browser-owner'
const testEpoch = identityEpoch()
let client: QueryClient
let originalLocks: PropertyDescriptor | undefined
let scopes: Map<string, TemporaryFileScope>
let staged: Map<string, FileWithRevision>
let uploadPaths: string[]
let finalizePaths: string[]
let sendCalls: SendOperatorMessageRequest[]
let agentCalls: SendAgentChatMessageRequest[]
let operatorStates: Map<string, OperatorConversationState>
let finalizeWait: Promise<void> | undefined
let loseOperatorAck: boolean
let releaseGates: Array<() => void>

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  releaseGates.push(resolve)
  return { promise, resolve }
}
function root(scope: TemporaryFileScope) {
  return scope.chat.kind === 'operator'
    ? `/api/operator/conversations/${scope.chat.conversationId}/files`
    : `/api/workspaces/${scope.chat.workspaceId}/agent-chat/conversations/${scope.chat.conversationId}/files`
}
function register(scope: TemporaryFileScope) { scopes.set(`${root(scope)}/uploads`, scope) }
function operatorScope(id = 'conversation-one'): TemporaryFileScope {
  return { kind: 'temporary', chat: { kind: 'operator', ownerPrincipalId: owner, operatorId: 'application-operator', conversationId: id } }
}
function agentScope(state: AgentChatState): TemporaryFileScope {
  const conversation = state.conversation!
  return { kind: 'temporary', chat: { kind: 'agent', workspaceId: conversation.workspaceId, workflowId: conversation.workflowId,
    agentId: conversation.agentId, conversationId: conversation.id,
    ...(conversation.origin.kind === 'run_execution' ? { runId: conversation.origin.runId, executionId: conversation.origin.executionId } : {}),
  } }
}
function idleAgent(): AgentChatState {
  return { ...structuredClone(agentChatFixtures.active), sessionState: 'idle', activeTurn: null, turns: [], messages: [], activities: [],
    availability: { canSend: true }, capabilities: { ...agentChatFixtures.active.capabilities, resume: true, queueNextTurn: true }, revision: 1 }
}
function TestLocalAccess({ children }: { children: ReactNode }) {
  // The production AppConnectionBoundary owns this same Query above RootShell.
  useLocalHumanAccessQuery()
  return children
}
function tree(children: ReactNode) {
  return <QueryClientProvider client={client}><TestLocalAccess>
    <ChatAttachmentBoundary>{children}</ChatAttachmentBoundary>
  </TestLocalAccess></QueryClientProvider>
}
function operatorTree() { return tree(<OperatorChatVisibilityProvider enabled><OperatorChat /></OperatorChatVisibilityProvider>) }
function panel(state: AgentChatState) { return <AgentChatPanel name="Coder" context={state.context} /> }
function compose(text: string) { fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: text } }) }
async function upload(name = 'notes.md') {
  const input = await screen.findByLabelText('Choose attachments')
  await waitFor(() => expect(screen.getByRole('button', { name: 'Attach files' })).toBeEnabled())
  await userEvent.setup().upload(input, new File(['# FIL-13 fixture'], name, { type: 'text/markdown' }))
}
async function uploaded(name = 'notes.md') {
  await waitFor(() => expect(screen.getByRole('list', { name: 'Attachments' })).toHaveTextContent('Ready'))
  expect(screen.getByRole('button', { name: `Remove attachment ${name}` })).toBeEnabled()
}
function hydrated(pins: SendOperatorMessageRequest['attachments']) {
  return (pins ?? []).map((pin) => {
    const found = [...staged.values()].find((row) => row.revision.fileId === pin.fileId && row.revision.revisionId === pin.revisionId)
    if (!found) throw new Error('Test sent an unallocated revision')
    return found
  })
}
function installAgent(initial: AgentChatState, unknown = false) {
  const mock = createAgentChatMock(initial)
  server.use(...mock.handlers)
  register(agentScope(initial))
  // Keep the existing auth/read fixtures, but use FIL-10 hydrated message readback for send.
  server.use(http.post('/api/workspaces/:workspaceId/agent-chat/messages', async ({ request, params }) => {
    const input = SendAgentChatMessageRequestSchema.parse(await request.json())
    agentCalls.push(input)
    const context = { workspaceId: String(params.workspaceId), ...input.context }
    const before = mock.getState(context)
    expect(input.expectedConversationId).toBe(before.conversation!.id)
    const at = new Date().toISOString()
    const turn: AgentChatTurn = { requestId: input.requestId, messageId: `message-${input.requestId}`, sequence: '1', intent: input.intent,
      delivery: unknown ? 'unknown' : 'queued', createdAt: at, updatedAt: at }
    const state: AgentChatState = { ...before, revision: before.revision + 1, turns: [...before.turns, turn],
      messages: [...before.messages, { id: turn.messageId, requestId: input.requestId, conversationId: before.conversation!.id,
        role: 'user', content: input.content, attachments: hydrated(input.attachments) }] }
    mock.setState(state)
    return HttpResponse.json(SendAgentChatMessageResponseSchema.parse({ state, turn, replayed: false }))
  }))
  return mock
}

beforeEach(installCanonicalOperatorFixture)
beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('graphql.identity-epoch', testEpoch)
  clearRevisionedFormPersistence()
  useConversationDraftStore.getState().clearAllDrafts()
  useOperatorChatStore.setState({ open: true, historyOpen: false, selectedConversationId: 'conversation-one' })
  installChatSource()
  vi.stubGlobal('crypto', { ...crypto, subtle: webcrypto.subtle, randomUUID: webcrypto.randomUUID.bind(webcrypto) })
  // Browser-wide lock fixture follows the existing outbox tests; no HTTP is performed under it.
  originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
  let tail: Promise<unknown> = Promise.resolve()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request<T>(name: string, options: LockOptions, callback: (lock: Lock) => T | PromiseLike<T>): Promise<T> {
      const next = tail.catch(() => { /* ignore: an earlier lock holder's failure belongs to its own caller. */ }).then(() => { options.signal?.throwIfAborted(); return callback({ name, mode: 'exclusive' } as Lock) })
      tail = next
      return next
    },
  } })
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  scopes = new Map(); staged = new Map(); uploadPaths = []; finalizePaths = []; sendCalls = []; agentCalls = []
  finalizeWait = undefined; loseOperatorAck = false; releaseGates = []
  operatorStates = new Map(['conversation-one', 'conversation-two'].map((id) => [id, operatorState({
    conversation: { ...operatorState().conversation, id, title: id }, messages: [], turnState: 'idle', activeRequestId: null,
  })]))
  register(operatorScope()); register(operatorScope('conversation-two'))
  server.use(
    http.get('/api/local-human', () => HttpResponse.json({ principal: { id: owner, name: 'FIL-13 tester', expiresAt: '2099-01-01T00:00:00.000Z', grants: [] } })),
    http.get('/api/management/settings/agents', () => HttpResponse.json({ revision: 1, versionId: null,
      value: { ...DEFAULT_AGENT_DEFAULTS, operator: { ...DEFAULT_AGENT_DEFAULTS.operator, harness: DEFAULT_HARNESS_DEFAULTS.codex } } })),
    http.get('/api/operator/setup', () => HttpResponse.json(configuredOperatorSetup('codex'))),
    http.get('/api/operator/conversations/summaries', () => HttpResponse.json({ conversations: [...operatorStates.values()].map(summarizeOperatorConversation) })),
    http.get('/api/operator/conversations/:id', ({ params }) => HttpResponse.json(operatorStates.get(String(params.id)))),
    http.post('*/files/uploads', async ({ request }) => {
      const path = new URL(request.url).pathname
      uploadPaths.push(path)
      const scope = scopes.get(path)
      if (!scope) throw new Error(`Wrong upload scope: ${path}`)
      const input = await request.json() as { requestId: string; filename: string; mediaType: FileMediaType; byteSize: number; sha256: string }
      const createdAt = new Date().toISOString()
      const value = FileWithRevisionSchema.parse({
        file: { fileId: `file-${input.requestId}`, currentRevisionId: `rev-${input.requestId}`, scope, state: 'pending', createdAt,
          retentionDurationSeconds: DEFAULT_FILE_RETENTION_SECONDS, expiresAt: temporaryFileExpiresAt(createdAt, DEFAULT_FILE_RETENTION_SECONDS) },
        revision: { fileId: `file-${input.requestId}`, revisionId: `rev-${input.requestId}`, filename: input.filename,
          mediaType: input.mediaType, byteSize: input.byteSize, sha256: input.sha256, origin: 'upload', createdAt },
      })
      staged.set(input.requestId, value)
      return HttpResponse.json({ value, replayed: false })
    }),
    http.put('*/files/uploads/:requestId', ({ request, params }) => {
      expect(request.headers.get('content-type')).toBe('application/octet-stream')
      return HttpResponse.json({ value: staged.get(String(params.requestId)), replayed: false })
    }),
    http.post('*/files/uploads/:requestId/finalize', async ({ request, params }) => {
      finalizePaths.push(new URL(request.url).pathname)
      await finalizeWait
      const previous = staged.get(String(params.requestId))!
      const value = FileWithRevisionSchema.parse({ ...previous, file: { ...previous.file, state: 'ready' } })
      staged.set(String(params.requestId), value)
      return HttpResponse.json({ value, replayed: false })
    }),
    http.delete('*/files/uploads/:requestId', ({ params }) => HttpResponse.json({ value: staged.get(String(params.requestId)), replayed: false })),
    http.post('/api/operator/conversations/:id/messages', async ({ params, request }) => {
      const input = SendOperatorMessageRequestSchema.parse(await request.json())
      sendCalls.push(input)
      const id = String(params.id), before = operatorStates.get(id)!
      const previous = before.messages.find((message) => message.requestId === input.requestId)
      if (previous) {
        // Display pins may grow after publication; the retry must keep the original command pins.
        expect(input.attachments).toEqual(sendCalls.find((command) => command.requestId === input.requestId)!.attachments)
        expect(previous.content).toBe(input.content)
        return HttpResponse.json({ state: before, replayed: true })
      }
      if (input.recovery === 'receipt') return HttpResponse.json({ error: { code: 'OPERATOR_RECEIPT_NOT_FOUND', message: 'No receipt' } }, { status: 404 })
      const message: Message = { id: `message-${input.requestId}`, conversationId: id, requestId: input.requestId, role: 'user',
        content: input.content, attachments: hydrated(input.attachments) }
      const state = { ...before, revision: before.revision + 1, messages: [...before.messages, message] }
      operatorStates.set(id, state)
      return loseOperatorAck ? HttpResponse.error() : HttpResponse.json({ state, replayed: false })
    }),
  )
})
afterEach(async () => {
  releaseGates.forEach((release) => release())
  cleanup()
  await act(async () => { await Promise.resolve() })
  client.clear()
  if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
  else Reflect.deleteProperty(navigator, 'locks')
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

describe('FIL-13 real chat mounts', () => {
  it.each(['operator', 'agent'] as const)('accepts a file dropped onto the %s composer with exact upload scope and send pins', async (kind) => {
    const initial = idleAgent()
    if (kind === 'agent') installAgent(initial)
    render(kind === 'operator' ? operatorTree() : tree(panel(initial)))
    await screen.findByRole('textbox', { name: 'Message' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Attach files' })).toBeEnabled())
    fireEvent.drop(screen.getByRole('textbox', { name: 'Message' }), { dataTransfer: {
      types: ['Files'], files: [new File(['# dropped chat'], 'dropped-chat.md', { type: 'text/markdown' })],
    } })
    await uploaded('dropped-chat.md')
    const expectedScope = kind === 'operator' ? operatorScope() : agentScope(initial)
    expect(uploadPaths).toEqual([`${root(expectedScope)}/uploads`])
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(kind === 'operator' ? sendCalls : agentCalls).toHaveLength(1))
    expect((kind === 'operator' ? sendCalls : agentCalls)[0].attachments).toEqual(messageAttachmentRefs({ attachments: [...staged.values()] }))
  })
  it('attaches and sends a file in a new Agent chat that has no conversation yet', async () => {
    const empty = agentChatFixtureFor(agentChatFixtures.empty, idleAgent().context)
    const mock = createAgentChatMock(empty)
    server.use(...mock.handlers)
    // The stored conversation is created by the first attachment; uploads then use its own scope.
    const created: TemporaryFileScope = { kind: 'temporary', chat: { kind: 'agent', workspaceId: empty.context.workspaceId,
      workflowId: empty.context.workflowId, agentId: empty.context.agentId, conversationId: 'conversation-created-1' } }
    register(created)
    render(tree(panel(empty)))
    await screen.findByRole('textbox', { name: 'Message' })
    await upload('first.md'); await uploaded('first.md')
    expect(mock.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/agent-chat/conversation'))).toHaveLength(1)
    expect(uploadPaths).toEqual([`${root(created)}/uploads`])
    compose('Review the first attachment')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(mock.calls.some((call) => call.path.endsWith('/agent-chat/messages'))).toBe(true))
    const sent = SendAgentChatMessageRequestSchema.parse(mock.calls.find((call) => call.path.endsWith('/agent-chat/messages'))!.body)
    expect(sent.expectedConversationId).toBe('conversation-created-1')
    expect(sent.attachments).toEqual(messageAttachmentRefs({ attachments: [...staged.values()] }))
  })
  it('sends an Operator file with exact pins and renders its persisted card after acceptance', async () => {
    render(operatorTree())
    await upload(); await uploaded()
    compose('Review the attachment')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(sendCalls).toHaveLength(1))
    const [file] = [...staged.values()]
    expect(sendCalls[0].attachments).toEqual(messageAttachmentRefs({ attachments: [file] }))
    expect(uploadPaths).toEqual([`${root(operatorScope())}/uploads`])
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Attachments' })).not.toBeInTheDocument())
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('')
    expect(within(screen.getByRole('article', { name: 'Message from You' })).getByText('notes.md')).toBeVisible()
    expect(readPendingOperatorMessage('conversation-one').command).toBeUndefined()
  })

  it('sends a Board Agent file without changing the selected Run or intent', async () => {
    const initial = idleAgent()
    installAgent(initial)
    render(tree(panel(initial)))
    await upload(); await uploaded()
    compose('Review the attachment')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(agentCalls).toHaveLength(1))
    expect(agentCalls[0]).toMatchObject({ intent: 'next_turn', expectedConversationId: initial.conversation!.id,
      attachments: messageAttachmentRefs({ attachments: [...staged.values()] }) })
    expect(agentCalls[0].context).toEqual({ workflowId: initial.context.workflowId, workflowNodeId: initial.context.workflowNodeId,
      agentId: initial.context.agentId, ...(initial.context.runId ? { runId: initial.context.runId } : {}) })
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Attachments' })).not.toBeInTheDocument())
    expect(screen.getByText('notes.md')).toBeVisible()
  })

  it('finishes an Operator upload in its original conversation after switching', async () => {
    const hold = gate(); finalizeWait = hold.promise
    render(operatorTree())
    await upload('one.md')
    await waitFor(() => expect(finalizePaths).toHaveLength(1))
    compose('first draft')
    act(() => useOperatorChatStore.getState().select('conversation-two'))
    await screen.findByRole('textbox', { name: 'Message' })
    await waitFor(() => expect(screen.queryByText('one.md')).not.toBeInTheDocument())
    await act(async () => { hold.resolve(); await hold.promise })
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('')
    act(() => useOperatorChatStore.getState().select('conversation-one'))
    await uploaded('one.md')
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('first draft')
    expect(finalizePaths[0]).toContain('/conversations/conversation-one/files/')
    expect(sendCalls).toHaveLength(0)
  })

  it('keeps a late Agent upload in Run A while Run B has an independent draft', async () => {
    const initial = agentChatFixtureFor(idleAgent(), { ...idleAgent().context, runId: 'run-a' }, 'chat-run-a')
    const other = agentChatFixtureFor(initial, { ...initial.context, runId: 'run-b' }, 'chat-run-b')
    const mock = installAgent(initial); mock.setState(other); register(agentScope(other))
    const hold = gate(); finalizeWait = hold.promise
    const view = render(tree(panel(initial)))
    await upload('run-a.md')
    await waitFor(() => expect(finalizePaths).toHaveLength(1))
    view.rerender(tree(panel(other)))
    await waitFor(() => expect(client.getQueryData(agentChatStateKey(other.context))).toBeDefined())
    await act(async () => { hold.resolve(); await hold.promise })
    await screen.findByRole('textbox', { name: 'Message' })
    expect(screen.queryByText('run-a.md')).not.toBeInTheDocument()
    compose('Run B draft')
    view.rerender(tree(panel(initial)))
    await uploaded('run-a.md')
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('')
    expect(finalizePaths[0]).toContain('/conversations/chat-run-a/files/')
    expect(agentCalls).toHaveLength(0)
  })

  it.each([false, true])('recovers an unknown Operator send without resending (R2-6 published output: %s)', async (published) => {
    loseOperatorAck = true
    render(operatorTree())
    await upload(); await uploaded()
    compose('Original file message')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(sendCalls).toHaveLength(1))
    const retry = await screen.findByRole('button', { name: 'Retry pending message' })
    await waitFor(() => expect(retry).toBeEnabled())
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Original file message')
    expect(screen.getByRole('list', { name: 'Attachments' })).toHaveTextContent('notes.md')
    expect(readPendingOperatorMessage('conversation-one').command).toMatchObject(sendCalls[0])
    if (published) {
      // Native publication finishes after durable admission but before receipt recovery.
      // Hydration exposes both input and output pins on the accepted user message.
      const before = operatorStates.get('conversation-one')!
      const source = before.messages[0].attachments![0]
      const output = FileWithRevisionSchema.parse({
        file: { ...source.file, fileId: 'published-output', currentRevisionId: 'published-revision' },
        revision: { ...source.revision, fileId: 'published-output', revisionId: 'published-revision',
          filename: 'result.md', origin: 'agent_output' },
      })
      operatorStates.set('conversation-one', { ...before, revision: before.revision + 1,
        messages: before.messages.map((message) => ({ ...message, attachments: [...(message.attachments ?? []), output] })),
      })
    }
    loseOperatorAck = false
    fireEvent.click(retry)
    await waitFor(() => expect(sendCalls).toHaveLength(2))
    expect(sendCalls[1]).toEqual({ ...sendCalls[0], recovery: 'receipt' })
    await waitFor(() => {
      expect(screen.queryByRole('list', { name: 'Attachments' })).not.toBeInTheDocument()
      expect(readPendingOperatorMessage('conversation-one').command).toBeUndefined()
      expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('')
      expect(screen.queryByRole('button', { name: 'Retry pending message' })).not.toBeInTheDocument()
    })
    const article = within(await screen.findByRole('article', { name: 'Message from You' }))
    expect(await article.findByText('notes.md')).toBeVisible()
    if (published) expect(await article.findByText('result.md')).toBeVisible()
    expect(operatorStates.get('conversation-one')!.messages).toHaveLength(1)
    expect(sendCalls.filter((command) => !command.recovery)).toHaveLength(1)
    expect(uploadPaths).toHaveLength(1)
  })

  it('keeps an Agent file draft on an unknown receipt, without an automatic resend', async () => {
    const initial = idleAgent(); installAgent(initial, true)
    render(tree(panel(initial)))
    await upload(); await uploaded()
    compose('Keep this file')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(agentCalls).toHaveLength(1))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled())
    expect(screen.getByRole('list', { name: 'Attachments' })).toHaveTextContent('notes.md')
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Keep this file')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await screen.findByText(/Delivery is unknown. Use/)
    expect(agentCalls).toHaveLength(1)
  })

  it.each([
    ['user', 'expired', 'Expired'], ['assistant', 'expired', 'Expired'],
    ['user', 'removed', 'Removed'], ['assistant', 'removed', 'Removed'],
    ['assistant', 'ready', 'Expired'],
  ] as const)('renders an attachment-only %s/%s tombstone with real expiry and no byte request', async (role, state, label) => {
    const createdAt = '2020-01-01T00:00:00.000Z'
    const expiresAt = temporaryFileExpiresAt(createdAt, DEFAULT_FILE_RETENTION_SECONDS)
    const file = FileWithRevisionSchema.parse({
      file: { fileId: 'expired-file', currentRevisionId: 'expired-revision', scope: operatorScope(), state, createdAt,
        retentionDurationSeconds: DEFAULT_FILE_RETENTION_SECONDS, expiresAt },
      revision: { fileId: 'expired-file', revisionId: 'expired-revision', filename: 'expired.md', mediaType: 'text/markdown',
        byteSize: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', origin: 'upload', createdAt },
    })
    let downloads = 0
    server.use(http.get('*/files/:fileId/revisions/:revisionId/content', () => { downloads++; return HttpResponse.error() }))
    render(tree(<OperatorMessages messages={[{ id: 'old-message', conversationId: 'conversation-one', role, content: '', attachments: [file] }]}
      activities={[]} onBrowse={() => {}} />))
    expect(screen.getByText('expired.md')).toBeVisible()
    expect(screen.getByText(label)).toBeVisible()
    expect(document.querySelector('time[datetime]')).toHaveAttribute('datetime', expiresAt)
    expect(screen.queryByRole('button', { name: /Download/ })).not.toBeInTheDocument()
    expect(downloads).toBe(0)
  })

  it('allows an attachment-only submit in both composers, while an empty message stays disabled', () => {
    const submit = vi.fn()
    const view = render(tree(<div style={{ width: 320 }}><OperatorComposer conversationId="composer" hasAttachments onSubmit={submit} onNewChat={() => {}} /></div>))
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    expect(submit).toHaveBeenLastCalledWith('')
    view.rerender(tree(<div className="agent-chat-composer-controls" style={{ width: 320 }}>
      <ConversationComposer conversationId="composer" hasAttachments onSubmit={submit} />
    </div>))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Enter' })
    expect(submit).toHaveBeenCalledTimes(2)
    view.rerender(tree(<ConversationComposer conversationId="composer" onSubmit={submit} />))
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    // jsdom asserts affordances only, not physical 320px layout.
  })

  it('the pinned Operator send contract must accept an attachment without text', () => {
    expect(SendOperatorMessageRequestSchema.safeParse({ requestId: 'file-only', content: '',
      attachments: [{ fileId: 'file', revisionId: 'revision' }] }).success).toBe(true)
  })
  it('the pinned Agent send contract must accept an attachment without text', () => {
    const selected = idleAgent().context
    const context = { workflowId: selected.workflowId, workflowNodeId: selected.workflowNodeId, agentId: selected.agentId,
      ...(selected.runId ? { runId: selected.runId } : {}) }
    expect(SendAgentChatMessageRequestSchema.safeParse({ requestId: 'file-only', content: '', context, intent: 'next_turn',
      expectedConversationId: 'conversation', attachments: [{ fileId: 'file', revisionId: 'revision' }] }).success).toBe(true)
  })
})
