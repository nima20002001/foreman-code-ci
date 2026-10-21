import assert from 'node:assert/strict'
import { it } from 'vitest'
import { HarnessExecutionContextSchema, HarnessExecutionSchema, type HarnessExecutionRequest } from '@foreman-code/contracts'
import { AcceptedWorkflowRunV3Schema, WorkActivationInputSchema,
  makeCurrentWorkflowFixture, WorkflowVersionV3Schema } from '@foreman-code/contracts/wave25'
import { buildHarnessPrompt } from '../src/modules/harnesses/prompt.js'
import { repeatNativeObserver } from '../src/modules/runs/repeatRuntime.js'
import { RunnerAdmission } from '../src/modules/runs/runnerAdmission.js'

it('the native observer supplies caller context separately from a historical continuation input', async () => {
  const fixture = makeCurrentWorkflowFixture('work-context')
  const version = WorkflowVersionV3Schema.parse({ ...fixture.version, definition: {
    ...fixture.version.definition, handoffs: { contractVersion: 1 },
  } })
  const node = fixture.version.definition.nodes[1]!
  const run = AcceptedWorkflowRunV3Schema.parse({ ...fixture.run,
    authorizationPrincipalId: 'context-author', executionState: 'running',
    executionLocation: { runnerId: 'runner-local', rootPath: '/accepted/project',
      locationRevision: 1, identityHash: `sha256:${'1'.repeat(64)}` },
  })
  const input = WorkActivationInputSchema.parse({ executionSemanticsVersion: 3, runInput: {},
    occurrence: null, entry: null, predecessors: [], work: { kind: 'work_return',
      activation: { scope: fixture.scope, activationId: 'continuation', workflowNodeId: node.id,
        lineageId: fixture.run.id, cause: { kind: 'work_return', returnId: 'review-return' } },
      returned: { scope: fixture.scope, returnId: 'review-return', requestId: 'review-request',
        sourceActivationId: 'review-activation', sourceExecutionId: 'review-execution',
        requesterActivationId: 'original-work', continuationActivationId: 'continuation',
        acceptedResultDigest: `sha256:${'2'.repeat(64)}`, outcome: 'needs_changes',
        latestDeliverable: { revision: 1 }, remainingFindings: ['revise'], returnedAt: fixture.createdAt },
      acceptedSourceResult: { outcome: 'succeeded', output: { routing: {
        kind: 'return', requestId: 'review-request', outcome: 'needs_changes',
      }, data: { latestDeliverable: { revision: 1 }, remainingFindings: ['revise'] } } },
    },
  })
  const execution = HarnessExecutionSchema.parse({ id: 'continuation-execution', runId: run.id,
    workflowNodeId: node.id, agentId: node.agentId,
    agentConfigurationVersionId: version.agentConfigurationVersionIds[node.agentId],
    attempt: 1, input, state: 'running', nativeSessionId: 'continuation-native-session',
    workingDirectory: run.executionLocation.rootPath, runtimeDirectory: '/accepted/runtime',
    createdAt: fixture.createdAt, startedAt: fixture.createdAt,
  })
  const callerContext = { parentRequest: { requestId: 'original-caller-request',
    requesterNodeId: version.entryNodeId } }
  let received: HarnessExecutionRequest | undefined
  let contextReads = 0
  const observer = repeatNativeObserver({ run, version,
    owner: { runId: run.id, assertOwned: () => undefined, client: {} } as never,
    store: {
      readExecution: async () => ({ execution, ref: { nodeId: node.id, occurrence: null } }),
      claimLaunch: async () => undefined,
      recoverSession: async () => execution,
      assertExecutionAdmission: async () => undefined,
      readWorkExecutionContext: async (id: string) => {
        assert.equal(id, execution.id)
        contextReads++
        return callerContext
      },
    } as never,
    native: {
      observeExact: async ({ request }: { request?: HarnessExecutionRequest }) => {
        assert.ok(request)
        received = request
        const contextLine = /^TRUSTED WORKFLOW EXECUTION CONTEXT\n(.+)$/m.exec(buildHarnessPrompt(request))?.[1]
        assert.ok(contextLine)
        const context = HarnessExecutionContextSchema.parse(JSON.parse(contextLine))
        assert.ok(context.parentRequest)
        const result = { outcome: 'succeeded', output: {
          routing: { kind: 'return', requestId: context.parentRequest.requestId, outcome: 'accepted' },
          data: { latestDeliverable: { revision: 2 }, remainingFindings: [] },
        } }
        return { state: 'completed', result, execution: HarnessExecutionSchema.parse({ ...execution,
          state: 'completed', finishedAt: fixture.createdAt, result }) }
      },
      assertResume: async () => { throw new Error('No approval is pending') },
    } as never,
    admission: new RunnerAdmission(1),
    workflows: { resolveNodeSkills: async (configuration) => configuration, referencesCreatedByExecution: async () => new Set<string>(), getAgentConfiguration: async () => fixture.configurations[1] },
    locations: { revalidateRunAuthorization: async () => undefined,
      revalidateSnapshot: async () => undefined } as never,
    directory: () => execution.runtimeDirectory!,
  })
  await observer(execution, new AbortController().signal)
  assert.equal(contextReads, 1)
  assert.deepEqual(received?.executionContext, callerContext)
  assert.deepEqual(received?.input, input)
  assert.equal('parentRequest' in input, false)
})
