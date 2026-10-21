import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { DEFAULT_CODEX_ADVANCED_CONFIGURATION } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture, WorkActivationInputSchema } from '@foreman-code/contracts/wave25'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { prepareCoordinationWorkflow } from './helpers/coordinationWorkflow.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

it.runIf(postgresEnabled).each(['choice', 'repeat', 'handoff'] as const)(
  'routes production %s results using the saved coordination protocol', async family => {
    const fixture = makeCurrentWorkflowFixture(randomUUID(), family === 'choice' ? 'conditional' : family === 'repeat' ? 'repeat' : 'sequential')
    fixture.version.approval = { handler: 'native' }
    fixture.version.definition.approval = fixture.version.approval
    fixture.run.approval = fixture.version.approval
    if (family === 'handoff') {
      fixture.version.definition.handoffs = { contractVersion: 1 }
      fixture.version.definition.executionPolicy = { maxParallelism: 1, maxNodeExecutions: 4 }
      fixture.version.definition.nodes[0]!.choice = { outcomes: [{ outcome: 'review',
        target: { kind: 'edge', relationshipId: fixture.version.definition.edges[0]!.id } }] }
    }
    for (const configuration of fixture.configurations) configuration.harness = {
      harness: 'codex', model: 'synthetic-no-native-call', reasoningEffort: 'low', sandbox: 'read-only',
      serviceTier: 'standard', advanced: { ...DEFAULT_CODEX_ADVANCED_CONFIGURATION, approvalPolicy: 'never' },
    }
    const outputs = new Map<string, unknown>()
    const failures: string[] = []
    const runtime = await currentOperatorIntegration({ fixture, insertRun: false, approvalNodeIds: [],
      reportDispatchFailure: (_id, _code, error) => failures.push(error instanceof Error ? error.stack ?? error.message : String(error)),
      outputFor: (nodeId, request) => {
        const node = fixture.version.definition.nodes.find(candidate => candidate.id === nodeId)!
        let business: Record<string, unknown> = { data: { text: 'Complete' } }
        if (family === 'handoff') {
          const input = WorkActivationInputSchema.parse(request.input)
          const review = input.work.kind === 'work_request'
          let routing: Record<string, unknown> = { kind: 'finish' }
          if (input.work.kind === 'entry') routing = { kind: 'request', outcome: 'review' }
          if (input.work.kind === 'work_request') routing = { kind: 'return', requestId: input.work.request.requestId, outcome: 'needs_changes' }
          business = { routing, data: { latestDeliverable: { text: 'Complete' }, remainingFindings: review ? ['Revise once'] : [] } }
        } else if (node.choice) {
          business = { routing: { outcome: node.choice.outcomes[0]!.outcome }, data: family === 'repeat'
            ? { latestDeliverable: { text: 'Complete' }, remainingFindings: [] } : { text: 'Complete' } }
        }
        const output = { text: JSON.stringify({ ...business, summary: 'Completed this activation.',
          board: { kind: 'none', reason: 'no_access' } }) }
        outputs.set(request.executionId, output)
        return output
      },
    })
    try {
      const prepared = await prepareCoordinationWorkflow(runtime)
      const started = await prepared.start()
      expect(started.run.resultProtocol).toBe('f1-f4-v1')
      await vi.waitFor(async () => {
        const details = await runtime.runs.getDetails(prepared.scope.workspaceId, started.run.id)
        expect(details?.run.outcome, JSON.stringify({ error: details?.run.result?.error,
          executions: details?.executions.map(execution => ({ node: execution.workflowNodeId, error: execution.result?.error })),
          dispatch: runtime.dispatchErrors, failures })).toBe('succeeded')
      },
        { timeout: 30000, interval: 50 })
      const details = await runtime.runs.getDetails(prepared.scope.workspaceId, started.run.id)
      expect(details!.executions.length).toBe(family === 'handoff' ? 3 : 2)
      for (const execution of details!.executions) {
        expect(execution.resultProtocol).toBe(started.run.resultProtocol)
        expect(execution.result).toEqual({ outcome: 'succeeded', output: outputs.get(execution.id) })
      }
    } finally { await runtime.close() }
  }, 60000)
