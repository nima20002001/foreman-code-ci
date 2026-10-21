import { describe, expect, it, vi } from 'vitest'
import type { CoordinatorConsultationBinding, NativeSessionReference } from '@foreman-code/contracts'
import { McpDetectionService } from '../src/modules/harnesses/mcpDetection.js'
import { prepareClaudeWorkflowCredentials } from '../src/modules/harnesses/claudeSdk/workflowCredentials.js'
import { managementEndpoint, productionClaudeFixture } from './support/claudeProduction.js'

const consultation: CoordinatorConsultationBinding = { runId: 'run', workflowVersionId: 'version',
  waitingActivationId: 'waiting-activation', delegationGroupId: 'delegation-group', consultationId: 'consultation',
  nativeSessionId: 'recorded-session', purpose: 'consultation' }
const session: NativeSessionReference = { harness: 'claude', nativeSessionId: consultation.nativeSessionId,
  providerVersion: '2.1.284' }

async function reply(f: ReturnType<typeof productionClaudeFixture>, stream: AsyncIterable<unknown>, text: string) {
  const events = (async () => { for await (const event of stream) void event })()
  await vi.waitFor(() => expect(f.queries.length).toBeGreaterThan(0))
  const message = (await f.queries.at(-1)!.messages.next()).value!
  expect(message.message.content).toBe(text)
  await f.frames.offer({ type: 'system', subtype: 'init', session_id: session.nativeSessionId,
    claude_code_version: session.providerVersion, cwd: '/recorded/work' })
  await f.frames.offer({ type: 'assistant', uuid: `${text}-reply`, session_id: session.nativeSessionId,
    user_message_uuid: message.uuid, message: { id: `${text}-message`, content: [{ type: 'text', text: 'Recorded reply' }] } })
  await f.frames.offer({ type: 'result', uuid: `${text}-result`, session_id: session.nativeSessionId,
    user_message_uuid: message.uuid, subtype: 'success', is_error: false, result: 'Recorded reply' })
  await events
}

describe('production Claude consultation credential preparation', () => {
  it.each(['cold', 'resident'] as const)('prepares a %s consultation before offering its input on the retained session', async phase => {
    const endpoint = await managementEndpoint(['source-token', 'consultation-token'])
    const f = productionClaudeFixture('workflow', undefined, endpoint.url, undefined, undefined,
      { coordinator: true, ...(phase === 'cold' ? { consultation } : {}) })
    const issue = (token: string) => ({ principalId: token, expiresAt: '2099-01-01T00:00:00Z',
      environment: { agentId: 'agent', variables: { GRAPHQL_MCP_TOKEN: token } } })
    const credentials = { issueForExecution: vi.fn(async () => issue('source-token')),
      issueForReviewer: vi.fn(async () => issue('source-token')),
      issueForConsultation: vi.fn(async () => issue('consultation-token')),
      revokeSupersededForExecution: vi.fn(async () => 0), revoke: vi.fn(async () => {}) }
    const inspector = f.factories.inspector(f.manager)
    const detection = new McpDetectionService(inspector, endpoint.url)
    const prepare = (consulting: boolean) => prepareClaudeWorkflowCredentials({
      input: { executionId: 'execution', harness: 'claude', workingDirectory: '/recorded/work',
        ...(consulting ? { purpose: 'consultation' as const, consultation,
          ...(phase === 'resident' ? { session } : {}) } : {}) },
      configuration: f.harness, claude: f, inspector, detection, credentials,
      runnerId: 'runner-local', endpoint: endpoint.url, refreshRoutes: async () => {},
    })
    try {
      if (phase === 'resident') {
        const prepared = await prepare(false)
        await reply(f, f.manager.startInitialTurn({ ...f.start, environment: prepared.credential.environment }, {
          prompt: 'Source input', clientCorrelationId: f.start.correlationId!, onSessionObserved: async observed => {
            expect(observed).toEqual(session)
          },
        }), 'Source input')
        await f.manager.retireTurn!(session, f.start.correlationId!)
      }
      f.workflow.execution.state = 'completed'
      f.workflow.execution.nativeSessionId = session.nativeSessionId
      f.workflow.execution.result = { outcome: 'succeeded', output: 'Delegated work' }
      f.workflow.execution.finishedAt = '2026-10-21T00:00:00Z'
      f.workflow.consultation = consultation
      const before = f.sdkQuery.mock.calls.length
      const prepared = await prepare(true)
      expect(prepared.detection.detection).toMatchObject({ state: 'connected', credentialArrangement: { kind: 'scoped_http_header' } })
      expect(credentials.issueForConsultation).toHaveBeenCalledExactlyOnceWith(consultation)
      expect(credentials.revoke).not.toHaveBeenCalled()
      const start = { kind: 'workflow-consultation' as const, consultation,
        request: f.start.kind === 'workflow' ? f.start.request : (() => { throw new Error('Expected workflow input') })(),
        correlationId: 'consultation:consultation', environment: prepared.credential.environment, instructionsDelivered: true as const }
      if (phase === 'cold') await f.manager.attachSession(session, start)
      else expect(f.sdkQuery.mock.calls.length).toBe(before)
      await reply(f, f.manager.startTurn(session, { prompt: 'Consultation input', clientCorrelationId: start.correlationId }),
        'Consultation input')
      expect((await f.manager.reconcile(session, start.correlationId)).terminalResult)
        .toEqual({ outcome: 'succeeded', output: 'Recorded reply' })
      expect(f.setMcpServers.mock.calls.at(-1)?.[0]).toMatchObject({ graphql: {
        headers: { Authorization: 'Bearer consultation-token' },
      } })
    } finally { await f.manager.dispose?.(); await endpoint.app.close() }
  }, 30_000)
})
