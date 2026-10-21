import { expect, it } from 'vitest'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { memoryWorkflow, workflowMemory } from './helpers/memoryWorkflow.js'

it.runIf(postgresEnabled).each([{ finding: null }, { finding: '' }, { finding: [] }])('retains a JSON finding $finding without aborting logical acceptance', async ({ finding }) => {
  const runtime = await currentOperatorIntegration({ fixture: memoryWorkflow('single'), approvalNodeIds: [],
    outputFor: () => ({ routing: { kind: 'finish' }, data: {
      latestDeliverable: { text: 'Needs direction' }, remainingFindings: [finding],
    } }),
  })
  try {
    const memory = await workflowMemory(runtime)
    await runtime.engine.start(runtime.f.run.id)
    const detail = await memory.read()
    expect(detail).toMatchObject({ card: { status: 'blocked', reason: expect.stringMatching(/\S/) },
      bindings: [{ state: 'blocked', reason: expect.stringMatching(/\S/) }] })
    const run = await runtime.runs.getDetails(memory.scope.workspaceId, runtime.f.run.id)
    expect(run?.run.executionState).toBe('waiting')
    expect(run?.executions[0]?.result).toMatchObject({ outcome: 'succeeded',
      output: { data: { remainingFindings: [finding] } } })
  } finally { await runtime.close() }
}, 60000)
