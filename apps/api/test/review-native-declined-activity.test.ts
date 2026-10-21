import { expect, it } from 'vitest'
import { projectNativeActivityFacts } from '../src/modules/runs/nativeActivitySnapshot.js'

it.each([false, true])('treats a declined Codex command as failed terminal evidence with parent terminal=%s', (terminal) => {
  const row = { execution_id: 'execution', sequence: '2', item_id: 'declined-command', item_type: 'commandExecution',
    status: 'declined', native_session_id: 'codex-session', native_turn_id: 'turn', generation: null, observed_at: null }
  const result = projectNativeActivityFacts([row], () => ({
    owner: { kind: 'execution', workspaceId: 'ws', workflowId: 'wf', runId: 'run', workflowVersionId: 'version', executionId: 'execution', attemptKey: '1' },
    harness: 'codex', sessionId: 'codex-session', terminal,
  }))
  expect(result.activities[0]).toMatchObject({ status: 'failed', evidence: 'confirmed' })
  expect(result.active).toEqual([])
})
