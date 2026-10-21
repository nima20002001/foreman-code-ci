import { describe, expect, it } from 'vitest'
import { makeCurrentWorkflowFixture, type CurrentFixtureForm } from './currentFixture.js'
import { CurrentEditStageInputSchema, CurrentEditAdvanceInputSchema, CurrentEditDiscardInputSchema,
  CurrentEditMutationToolInputSchema } from './currentEditIntent.js'
import { CurrentJournalRunPinSchema, CurrentJournalRunStateSchema, CurrentJournalStopSchema } from './currentJournal.js'

const forms: CurrentFixtureForm[] = ['single', 'sequential', 'parallel', 'conditional', 'approval', 'repeat']
function stage(form: CurrentFixtureForm) {
  const f = makeCurrentWorkflowFixture(`edit-${form}`, form)
  return { workspaceId: f.scope.workspaceId, workflowId: f.scope.workflowId, draftId: 'draft',
    action: 'stage_edits' as const, commandId: `stage-${form}`, expectedRevision: 1,
    expectedWorkflowVersionId: f.version.id, executionSemanticsVersion: 3 as const,
    expectedAgentConfigurationVersionIds: f.version.agentConfigurationVersionIds,
    graph: f.version.definition }
}
describe('one current private edit journal', () => {
  it.each(forms)('stages the complete V3 graph for %s', (form) => {
    const input = stage(form)
    expect(CurrentEditStageInputSchema.parse(input)).toEqual(input)
    expect(CurrentEditMutationToolInputSchema.parse(input)).toEqual(input)
    expect(Object.hasOwn(input.graph, 'repeat')).toBe(form === 'repeat')
    for (const field of ['selectedRunId', 'stops', 'ownerPrincipalId', 'credentials']) {
      expect(CurrentEditStageInputSchema.safeParse({ ...input, [field]: 'untrusted' }).success).toBe(false)
    }
    expect(CurrentEditStageInputSchema.safeParse({ ...input, executionSemanticsVersion: 2 }).success).toBe(false)
  })
  it('keeps exact advance/discard commands distinct from Stage', () => {
    const command = { workspaceId: 'workspace', workflowId: 'workflow', draftId: 'draft',
      intentId: 'intent', commandId: 'command' }
    expect(CurrentEditAdvanceInputSchema.parse({ ...command, action: 'stop_and_save' }).commandId).toBe('command')
    expect(CurrentEditDiscardInputSchema.parse({ ...command, action: 'discard_edits' }).commandId).toBe('command')
    expect(CurrentEditAdvanceInputSchema.safeParse({ ...command, action: 'discard_edits' }).success).toBe(false)
    expect(CurrentEditMutationToolInputSchema.safeParse({ ...command, action: 'stop_and_save', graph: stage('single').graph }).success).toBe(false)
  })
  it('keeps Stop acceptance separate from process closure and exact Run pins', () => {
    const stop = { input: { workspaceId: 'workspace', runId: 'run', commandId: 'stop' },
      receipt: { runId: 'run', status: 'accepted', processStopped: false } }
    expect(CurrentJournalStopSchema.parse(stop)).toEqual(stop)
    expect(CurrentJournalStopSchema.safeParse({ ...stop, receipt: { ...stop.receipt, processStopped: true } }).success).toBe(false)
    const pin = CurrentJournalRunPinSchema.parse({ workspaceId: 'workspace', workflowId: 'workflow',
      workflowVersionId: 'version', runId: 'run', executionSemanticsVersion: 3,
      agentConfigurationVersionIds: { agent: 'configuration' } })
    const pending = { pin, terminal: true, settled: false, outcome: 'succeeded', cleanupPending: true,
      nativePending: true, interactionPending: true, reviewPending: true }
    expect(CurrentJournalRunStateSchema.parse(pending)).toEqual(pending)
    expect(CurrentJournalRunStateSchema.safeParse({ ...pending, nativePending: undefined }).success).toBe(false)
    expect(CurrentJournalRunStateSchema.safeParse({ ...pending, settled: true }).success).toBe(false)
  })
})
