import { describe, expect, it } from 'vitest'
import type { ActivityScope } from '@foreman-code/contracts'
import { projectActivityCommands } from '../src/modules/conversations/activityCommands.js'
const scope: ActivityScope = { kind: 'agent_chat', conversationId: 'conversation', workspaceId: 'ws', workflowId: 'wf', nodeId: 'node', agentId: 'agent' }
const control = { schemaVersion: 1, kind: 'respond', conversationId: 'conversation', modelRequestId: 'A', scope,
  native: { harness: 'codex', sessionId: 'session', turnId: 'turn', requestId: 'question', requestType: 'approval' },
  choice: { optionId: 'approve', semantic: 'approve_once' } }
const receipt = (status: string, metadata: unknown = control) => ({ principal_id: 'principal', operation: 'agent_chat_control', command_id: 'command', revision: '9007199254740993', status, control: metadata })
describe('existing control receipt activity', () => {
  it('preserves Claude observed message and callback generation without inventing a turn', () => {
    const accepted = { ...control, native: { harness: 'claude', sessionId: 'session', messageId: 'message', generation: 'generation-A',
      requestId: 'question', requestType: 'can_use_tool' } }
    const summary = projectActivityCommands('conversation', scope, [receipt('uncertain', accepted)], '7').summaries[0]
    expect(summary?.native).toEqual({ harness: 'claude', sessionId: 'session', messageId: 'message', generation: 'generation-A', requestId: 'question' })
    expect(summary?.delivery).toBe('uncertain')
  })
  it.each(['pending', 'completed'])('projects %s as recorded answer without inferring native delivery', (status) => {
    const result = projectActivityCommands('conversation', scope, [receipt(status)], '7')
    expect(result.summaries[0]).toMatchObject({ delivery: 'answer_recorded', answerRecorded: true, providerAcknowledged: false, workerAcknowledged: false,
      native: { sessionId: 'session', turnId: 'turn', requestId: 'question' } })
    expect(result.sourceRevisions[0]).toMatchObject({ source: 'command', revision: '9007199254740993' })
  })
  it('requires exact qualified provider proof plus accepted provider version before delivered', () => {
    const acknowledgment = { source: 'provider_acknowledgement', harness: 'codex', providerVersion: 'version', nativeSessionId: 'session',
      nativeRequestId: 'question', nativeRequestType: 'approval', optionId: 'approve', semantic: 'approve_once' }
    const accepted = { ...control, native: { ...control.native, providerVersion: 'version' } }
    expect(projectActivityCommands('conversation', scope, [{ ...receipt('completed', accepted), acknowledgment }], '7').summaries[0])
      .toMatchObject({ delivery: 'delivered', providerAcknowledged: true, workerAcknowledged: false })
    expect(projectActivityCommands('conversation', scope, [{ ...receipt('completed'), acknowledgment }], '7').summaries[0]?.providerAcknowledged).toBe(false)
    expect(projectActivityCommands('conversation', scope, [{ ...receipt('completed', accepted), acknowledgment: { ...acknowledgment, nativeRequestId: 'foreign' } }], '7').summaries[0]?.providerAcknowledged).toBe(false)
  })
  it('retains older uncertain delivery beside a newer rejected command without comparing unrelated counters', () => {
    const rejected = { ...receipt('rejected'), command_id: 'newer', revision: '1' }
    const result = projectActivityCommands('conversation', scope, [receipt('uncertain'), rejected], '7')
    expect(result.summaries[0]).toMatchObject({ revision: '7', delivery: 'uncertain', providerAcknowledged: false })
    expect(result.summaries[0]?.sourceRevisions).toHaveLength(3)
  })
  it('preserves uncertainty/rejection and does not reconstruct authority for legacy or foreign scope', () => {
    expect(projectActivityCommands('conversation', scope, [receipt('uncertain')], '7').summaries[0]?.delivery).toBe('uncertain')
    expect(projectActivityCommands('conversation', scope, [receipt('rejected')], '7').summaries[0]?.delivery).toBe('failed')
    expect(projectActivityCommands('conversation', scope, [receipt('completed', null)], '7').summaries).toEqual([])
    expect(projectActivityCommands('conversation', scope, [receipt('completed', { ...control, scope: { ...scope, agentId: 'other' } })], '7').summaries).toEqual([])
  })
})
