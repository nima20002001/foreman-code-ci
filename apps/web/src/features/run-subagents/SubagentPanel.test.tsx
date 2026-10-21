import { createRef } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { subagentCapabilities, RunSubagentInputSchema, RunSubagentInterruptSchema } from '@foreman-code/contracts/subagents'
import { CODEX_APPROVAL_OPTIONS_FIXTURE } from '@foreman-code/contracts'
import { server } from '../../mocks/server'
import { SubagentPanel } from './SubagentPanel'
import { base, child, detail, message, receipt, scope, tool } from './testFixtures'

const anchor = createRef<HTMLButtonElement>()
const clients: QueryClient[] = []
afterEach(() => { clients.forEach((client) => client.clear()); clients.length = 0 })
beforeEach(() => {
  server.use(
    http.get(`${base}/:subagentId`, () => HttpResponse.json(detail())),
    http.get(`${base}/:subagentId/messages`, () => HttpResponse.json({ items: [], nextCursor: null, coverage: child().coverage })),
    http.get(`${base}/:subagentId/tools`, () => HttpResponse.json({ items: [tool()], nextCursor: null, coverage: child().coverage })),
  )
})
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const close = vi.fn()
  const rendered = render(<QueryClientProvider client={client}><SubagentPanel scope={scope} subagentId="child-1" anchor={anchor} onClose={close} /></QueryClientProvider>)
  return { client, close, ...rendered }
}
function qualified() {
  const capabilities = subagentCapabilities('codex-collab')
  capabilities.sendInput = { support: 'supported', qualification: 'passed' }
  capabilities.interrupt = { support: 'supported', qualification: 'passed' }
  return { subagent: child({ provider: 'codex', nativeMode: 'codex-collab', status: 'waiting', capabilities }),
    availableActions: { sendInput: true, interrupt: true, blockedReason: null } }
}
describe('Subagent panel', () => {
  it('validates and answers a child form through the shared response UI', async () => {
    const record = { ...detail(), availableActions: { ...detail().availableActions, respond: true },
      pendingInteraction: { session: { harness: 'codex', providerVersion: '0.154.0', nativeSessionId: 'native-child' },
        turn: { nativeTurnId: 'child-turn', nativeRequestId: 'child-request' },
        nativeRequestType: 'mcpServer/elicitation/request', request: {},
        responseOptions: [{ ...CODEX_APPROVAL_OPTIONS_FIXTURE[0]!, label: 'Submit details',
          input: { kind: 'form', schema: { type: 'object', required: ['count'],
            properties: { count: { title: 'Count', type: 'integer', minimum: 1 } } } } }] } }
    const bodies: Record<string, unknown>[] = []
    server.use(http.get(`${base}/:subagentId`, () => HttpResponse.json(record)),
      http.post(`${base}/:subagentId/responses`, async ({ request }) => {
        const body = await request.json() as Record<string, unknown>
        bodies.push(body)
        return HttpResponse.json(receipt({ commandId: String(body.commandId),
          operation: 'run_subagent_respond_v1', expectedRevision: String(body.expectedRevision) }))
      }))
    mount()
    const submit = await screen.findByRole('button', { name: 'Submit details' })
    fireEvent.click(submit)
    expect(await screen.findByRole('alert')).toHaveTextContent('Check your answers')
    expect(bodies).toHaveLength(0)
    fireEvent.change(screen.getByLabelText('Count (required)'), { target: { value: '2' } })
    fireEvent.click(submit)
    expect(await screen.findByText('Response delivered to the subagent.')).toBeVisible()
    expect(bodies).toMatchObject([{ nativeRequestId: 'child-request', response: { count: 2 } }])
  })

  it.each(['codex-multi-agent-v2', 'codex-collab'] as const)('sends input and interruption for qualified %s children', async nativeMode => {
    const input = vi.fn(async ({ request }: { request: Request }) => {
      const submitted = RunSubagentInputSchema.parse(await request.json())
      return HttpResponse.json(receipt({ commandId: submitted.commandId, expectedRevision: submitted.expectedRevision }))
    })
    const interrupt = vi.fn(async ({ request }: { request: Request }) => {
      const submitted = RunSubagentInterruptSchema.parse(await request.json())
      return HttpResponse.json(receipt({ commandId: submitted.commandId, expectedRevision: submitted.expectedRevision,
        operation: 'run_subagent_interrupt_v1' }))
    })
    const capabilities = subagentCapabilities(nativeMode)
    capabilities.sendInput = { support: 'supported', qualification: 'passed' }
    capabilities.interrupt = { support: 'supported', qualification: 'passed' }
    const record = { subagent: child({ nativeMode, capabilities }),
      availableActions: { sendInput: true, interrupt: true, blockedReason: null } }
    server.use(
      http.get(`${base}/:subagentId`, () => HttpResponse.json(record)),
      http.get(`${base}/:subagentId/messages`, () => HttpResponse.json({
        items: [message()], nextCursor: null, coverage: record.subagent.coverage,
      })),
      http.post(`${base}/:subagentId/input`, input),
      http.post(`${base}/:subagentId/interrupt`, interrupt),
    )
    mount()
    expect(await screen.findByText('Child answer')).toBeVisible()
    fireEvent.change(screen.getByRole('textbox', { name: 'Message to subagent' }), { target: { value: 'Follow up' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByText('Message delivered to the subagent.')
    expect(input).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Interrupt' }))
    await screen.findByText('Interrupt delivered to the subagent.')
    expect(interrupt).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('tab', { name: /Tool calls/ }))
    expect(await screen.findByText('read_file')).toBeVisible()
  })
  it('requires native qualification and live availability independently', async () => {
    const unqualified = qualified()
    unqualified.subagent.capabilities.sendInput.qualification = 'unverified'
    server.use(http.get(`${base}/:subagentId`, () => HttpResponse.json(unqualified)))
    const first = mount()
    expect(await screen.findByRole('button', { name: 'Interrupt' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument()
    first.unmount()
    const unavailable = qualified()
    unavailable.availableActions.interrupt = false
    server.use(http.get(`${base}/:subagentId`, () => HttpResponse.json(unavailable)))
    const second = mount()
    expect(await screen.findByRole('button', { name: 'Send' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Interrupt' })).not.toBeInTheDocument()
    second.unmount()
    const neither = qualified()
    neither.subagent.capabilities.sendInput.qualification = 'unverified'
    neither.availableActions.interrupt = false
    server.use(http.get(`${base}/:subagentId`, () => HttpResponse.json(neither)))
    mount()
    await screen.findByText('Controls are unavailable for this subagent right now.')
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Interrupt' })).not.toBeInTheDocument()
  })
  it('allows qualified idle follow-up to a completed child when the live service advertises it', async () => {
    const record = qualified()
    record.subagent.status = 'completed'
    record.availableActions.interrupt = false
    server.use(http.get(`${base}/:subagentId`, () => HttpResponse.json(record)))
    mount()
    expect(await screen.findByRole('textbox', { name: 'Message to subagent' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Interrupt' })).not.toBeInTheDocument()
  })
  it('sends input with the exact read revision and treats ACK as acceptance', async () => {
    const bodies: unknown[] = []
    server.use(http.get(`${base}/:subagentId`, () => HttpResponse.json(qualified())),
      http.post(`${base}/:subagentId/input`, async ({ request }) => {
        const body = await request.json() as { commandId: string; expectedRevision: string }
        bodies.push(body)
        return HttpResponse.json(receipt({ commandId: body.commandId, expectedRevision: body.expectedRevision }))
      }))
    mount()
    const input = await screen.findByRole('textbox', { name: 'Message to subagent' })
    fireEvent.change(input, { target: { value: 'Continue with evidence' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByText('Message delivered to the subagent.')
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ workspaceId: scope.workspaceId, runId: scope.runId, subagentId: 'child-1', expectedRevision: '4', text: 'Continue with evidence' })
    expect(input).toHaveValue('')
  })
  it('rechecks an uncertain input using the same command identity and payload', async () => {
    const bodies: unknown[] = []
    server.use(http.get(`${base}/:subagentId`, () => HttpResponse.json(qualified())),
      http.post(`${base}/:subagentId/input`, async ({ request }) => {
        const body = await request.json() as { commandId: string }
        bodies.push(body)
        return HttpResponse.json(receipt({ commandId: body.commandId, state: bodies.length === 1 ? 'uncertain' : 'acknowledged' }))
      }))
    mount()
    fireEvent.change(await screen.findByRole('textbox', { name: 'Message to subagent' }), { target: { value: 'One command' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByRole('button', { name: 'Check again' })
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await screen.findByText('Message delivered to the subagent.')
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toEqual(bodies[0])
  })
  it('keeps a mismatched command receipt unconfirmed and rechecks the original request', async () => {
    const bodies: unknown[] = []
    server.use(http.get(`${base}/:subagentId`, () => HttpResponse.json(qualified())),
      http.post(`${base}/:subagentId/input`, async ({ request }) => {
        const body = RunSubagentInputSchema.parse(await request.json())
        bodies.push(body)
        return HttpResponse.json(receipt({ expectedRevision: body.expectedRevision,
          commandId: bodies.length === 1 ? 'another-command' : body.commandId }))
      }))
    mount()
    fireEvent.change(await screen.findByRole('textbox', { name: 'Message to subagent' }),
      { target: { value: 'One owned request' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't confirm delivery.")
    expect(screen.queryByText('Message delivered to the subagent.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(await screen.findByText('Message delivered to the subagent.')).toBeVisible()
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toEqual(bodies[0])
  })
  it('retains an uncertain command across closing and reopening the panel', async () => {
    const bodies: unknown[] = []
    server.use(http.get(`${base}/:subagentId`, () => HttpResponse.json(qualified())),
      http.post(`${base}/:subagentId/input`, async ({ request }) => {
        const body = await request.json() as { commandId: string }
        bodies.push(body)
        return HttpResponse.json(receipt({ commandId: body.commandId, state: bodies.length === 1 ? 'uncertain' : 'acknowledged' }))
      }))
    const { client, close, rerender } = mount()
    fireEvent.change(await screen.findByRole('textbox', { name: 'Message to subagent' }), { target: { value: 'One durable command' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByRole('button', { name: 'Check again' })
    rerender(<QueryClientProvider client={client}><span>Closed</span></QueryClientProvider>)
    rerender(<QueryClientProvider client={client}><SubagentPanel scope={scope} subagentId="child-1" anchor={anchor} onClose={close} /></QueryClientProvider>)
    fireEvent.click(await screen.findByRole('button', { name: 'Check again' }))
    await screen.findByText('Message delivered to the subagent.')
    expect(bodies[1]).toEqual(bodies[0])
  })
  it('reads a fresh revision after a conflict before admitting a new command', async () => {
    const record = qualified()
    const bodies: { commandId: string; expectedRevision: string }[] = []
    server.use(http.get(`${base}/:subagentId`, () => HttpResponse.json(record)),
      http.post(`${base}/:subagentId/input`, async ({ request }) => {
        const body = await request.json() as { commandId: string; expectedRevision: string }
        bodies.push(body)
        if (bodies.length === 1) {
          record.subagent.revision = '5'
          return HttpResponse.json({ error: { code: 'SUBAGENT_REVISION_CONFLICT', message: 'Read again' } }, { status: 409 })
        }
        return HttpResponse.json(receipt({ commandId: body.commandId, expectedRevision: body.expectedRevision }))
      }))
    mount()
    fireEvent.change(await screen.findByRole('textbox', { name: 'Message to subagent' }), { target: { value: 'Fresh read' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByText('Message delivered to the subagent.')
    expect(bodies.map((body) => body.expectedRevision)).toEqual(['4', '5'])
    expect(bodies[1]?.commandId).not.toBe(bodies[0]?.commandId)
  })
  it('interrupts only through the advertised qualified action', async () => {
    let body: unknown
    server.use(http.get(`${base}/:subagentId`, () => HttpResponse.json(qualified())),
      http.post(`${base}/:subagentId/interrupt`, async ({ request }) => {
        body = await request.json()
        return HttpResponse.json(receipt({ ...(body as object), operation: 'run_subagent_interrupt_v1' }))
      }))
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Interrupt' }))
    await screen.findByText('Interrupt delivered to the subagent.')
    expect(body).toMatchObject({ expectedRevision: '4', subagentId: 'child-1' })
    expect(body).not.toHaveProperty('text')
  })
  it('locks dismissal while a command is pending and unlocks after delivery', async () => {
    let finish!: () => void
    const delivery = new Promise<void>((resolve) => { finish = resolve })
    server.use(http.get(`${base}/:subagentId`, () => HttpResponse.json(qualified())),
      http.post(`${base}/:subagentId/interrupt`, async ({ request }) => {
        const body = RunSubagentInterruptSchema.parse(await request.json())
        await delivery
        return HttpResponse.json(receipt({ ...body, operation: 'run_subagent_interrupt_v1' }))
      }))
    const { close } = mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Interrupt' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true'))
    expect(screen.getByRole('button', { name: 'Close subagent' })).toBeDisabled()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    fireEvent.pointerDown(document.body)
    fireEvent.click(document.body)
    expect(close).not.toHaveBeenCalled()
    finish()
    await screen.findByText('Interrupt delivered to the subagent.')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(close).toHaveBeenCalledOnce()
  })
  it('loads later transcript pages and distinguishes unavailable coverage', async () => {
    server.use(http.get(`${base}/:subagentId/messages`, ({ request }) => HttpResponse.json(new URL(request.url).searchParams.has('cursor')
      ? { items: [message('message-2', 'Later answer')], nextCursor: null, coverage: { ...child().coverage, transcript: 'unavailable' } }
      : { items: [message()], nextCursor: 'next-page', coverage: child().coverage })))
    mount()
    await screen.findByText('Child answer')
    fireEvent.click(screen.getByRole('button', { name: 'Load more messages' }))
    await screen.findByText('Later answer')
    expect(screen.getByText("Codex doesn't share this subagent's conversation.")).toBeVisible()
    expect(screen.getByText('Child answer')).toBeVisible()
  })
  it('closes on outside clicks but keeps clicks and drags from inside open', async () => {
    const { close } = mount()
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'false')
    await screen.findByText('Controls are unavailable for this subagent right now.')
    const inside = screen.getByRole('tab', { name: /Messages/ })
    fireEvent.pointerDown(inside); fireEvent.click(document.body)
    expect(close).not.toHaveBeenCalled()
    fireEvent.pointerDown(inside); fireEvent.click(inside)
    expect(close).not.toHaveBeenCalled()
    fireEvent.pointerDown(document.body); fireEvent.click(document.body)
    await waitFor(() => expect(close).toHaveBeenCalledOnce())
  })
})

it('shows a recorded OpenCode child without controls even when the saved projection advertises them', async () => {
  const historical = { ...qualified(), subagent: child({ ...qualified().subagent,
    provider: 'opencode', nativeMode: 'opencode-task' }) }
  server.use(http.get(`${base}/:subagentId`, () => HttpResponse.json(historical)))
  mount()
  expect(await screen.findByText(/Retired harness \(OpenCode\): read-only/)).toBeVisible()
  expect(screen.queryByRole('textbox', { name: 'Message to subagent' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Interrupt' })).not.toBeInTheDocument()
})

it('moves idle delivery guidance to a hint and removes redundant empty-history prose', async () => {
  const record = qualified()
  record.subagent.capabilities.inputTiming = 'idle'
  server.use(http.get(`${base}/:subagentId`, () => HttpResponse.json(record)))
  mount()
  expect(await screen.findByText('No messages yet')).toBeVisible()
  expect(screen.queryByText('Messages appear here as the subagent works.')).not.toBeInTheDocument()
  expect(screen.queryByText('Delivered when the subagent is waiting for input.')).not.toBeInTheDocument()
  fireEvent.focus(screen.getByRole('button', { name: 'About Message to subagent' }))
  expect(screen.getByRole('tooltip')).toHaveTextContent('Delivered when the subagent is waiting for input.')
})
