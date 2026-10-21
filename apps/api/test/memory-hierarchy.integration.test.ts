import { expect, it } from 'vitest'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { hierarchyRuntimeFixture, coordinationOutput } from './helpers/hierarchyRuntimeFixture.js'
import { ControlledWorkflowProvider } from './helpers/controlledWorkflowProvider.js'
import { workflowMemory } from './helpers/memoryWorkflow.js'

it.each([undefined, {}])('keeps linked master memory active until delegated hierarchy work returns with ports %j', async collaborationPorts => {
  const provider = new ControlledWorkflowProvider(['builder'], (node, request) => coordinationOutput(node, request,
    node === 'master' ? { select: ['build'] } : {}))
  const runtime = await currentOperatorIntegration({ fixture: hierarchyRuntimeFixture(), approvalNodeIds: [],
    ...(collaborationPorts ? { collaborationPorts } : {}), managerFactory: context => provider.connection(context) })
  const card = await workflowMemory(runtime)
  const drive = runtime.engine.start(runtime.f.run.id).catch(error => {
    console.error('Hierarchy memory Run failed', error)
    return error
  })
  let entered = false
  void provider.entered('builder').then(() => { entered = true })
  try {
    await expect.poll(async () => ({ entered, run: await runtime.runs.get(runtime.f.run.id),
      executions: (await runtime.runs.listRepeatExecutions(runtime.f.run.id)).map(row => row.execution) }),
    { timeout: 60_000 }).toMatchObject({ entered: true })
    expect(await card.read()).toMatchObject({ card: { status: 'doing' },
      bindings: [expect.objectContaining({ state: 'waiting_children' })] })
    provider.release('builder')
    expect(await drive).not.toBeInstanceOf(Error)
    expect((await runtime.runs.get(runtime.f.run.id))?.outcome).toBe('succeeded')
    expect(await card.read()).toMatchObject({ card: { status: 'done', completionKind: 'completed' },
      bindings: expect.arrayContaining([expect.objectContaining({ state: 'accepted' })]) })
  } catch (error) {
    const run = await runtime.runs.get(runtime.f.run.id)
    console.error('Hierarchy memory state', JSON.stringify({
      state: run?.executionState, outcome: run?.outcome,
      executions: (await runtime.runs.listRepeatExecutions(runtime.f.run.id)).map(({ execution }) => ({
        node: execution.workflowNodeId, attempt: execution.attempt, state: execution.state, result: execution.result,
      })),
      dispatchErrors: runtime.dispatchErrors,
    }))
    throw error
  } finally {
    provider.releaseAll()
    await runtime.stop()
    await drive
    await runtime.close()
  }
}, 120_000)
