import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { ManagedWorkspaceSchema } from '@foreman-code/contracts/management'
import { describe, expect, it } from 'vitest'
import { CURRENT_WORKFLOW_TOOLS, CurrentWorkflowReadResultSchema, CurrentWorkflowSaveResultSchema,
  ManualRunStartResultSchema, SavedRunDetailsSchema } from '@foreman-code/contracts/wave25'
import { remoteReviewProduction, waitForRemoteReview } from './helpers/remoteReviewProduction.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'

const outputSchema = { type: 'object', properties: { summary: { type: 'string' } },
  required: ['summary'], additionalProperties: false }
const corrected = { summary: 'Corrected deliverable' }

describe('Worker workflow output correction through authenticated MCP', () => {
  it.each(['handoff', 'deliverable', 'exhausted'] as const)(
    'validates and journals %s corrections on the original native session', async kind => {
      const f = await remoteReviewProduction({ workflow: 'single', executionHost: 'worker',
        parallelSetup: true, parallelProfileChecks: true, includeNodeRuntimePayload: false })
      try {
        const scope = { workspaceId: f.version.workspaceId, workflowId: f.version.workflowId }
        const saved = CurrentWorkflowReadResultSchema.parse(await f.value(CURRENT_WORKFLOW_TOOLS.saved, scope))
        const graph = structuredClone(saved.version.definition)
        const node = graph.nodes[0]!
        if (node.kind === 'job') throw new Error('Expected an Agent')
        node.outputSchema = outputSchema
        if (kind === 'handoff') graph.handoffs = { contractVersion: 1 }
        const finalAnswer = kind === 'handoff'
          ? { routing: { kind: 'finish' }, data: { latestDeliverable: corrected, remainingFindings: [] } }
          : corrected
        const invalid = kind === 'handoff' ? { routing: { kind: 'invalid' } } : {}
        const answers = kind === 'exhausted' ? [invalid, invalid, invalid] : [invalid, finalAnswer]
        await writeFile(join(f.provider.directory, 'workflow-answers.json'),
          JSON.stringify(answers.map(answer => JSON.stringify(answer))))
        const changed = CurrentWorkflowSaveResultSchema.parse(await f.value(CURRENT_WORKFLOW_TOOLS.save, {
          ...scope, graph, executionSemanticsVersion: 3,
          expectedRevision: saved.revision, expectedWorkflowVersionId: saved.version.id,
          expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds,
        })).value
        const version = changed.version
        const workspace = ManagedWorkspaceSchema.parse(await f.value('workspace_get', { workspaceId: scope.workspaceId }))
        const reader = await f.access.issue({ name: 'Output result reader', audience: 'operator',
          expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['runs:read'],
            scope: { workspaceIds: [scope.workspaceId] } }] })
        const start = { ...scope, workflowVersionId: version.id, commandId: randomUUID(),
          executionSemanticsVersion: 3, input: {}, expectedWorkflowRevision: changed.revision,
          expectedAgentConfigurationVersionIds: version.agentConfigurationVersionIds,
          expectedLocationRevision: workspace.locationRevision }
        await expectMcpAccessDenied(f.call('run_start', start, reader.token))
        const started = await waitForRemoteReview(async () => {
          try { return ManualRunStartResultSchema.parse(await f.value('run_start', start)) } catch (error) {
            if (error instanceof Error && error.message.includes('HARNESS_PROFILE_CHECK_PENDING')) return undefined
            throw error
          }
        }, value => value !== undefined, 'output workflow Start')
        const details = await waitForRemoteReview(async () => {
          await f.reconcile()
          return f.details(started!.run.id)
        }, value => value.run.executionState === 'completed', 'Worker output validation completion')
        expect(details.executions).toHaveLength(1)
        const execution = details.executions[0]!
        const expectedRepairs = kind === 'exhausted' ? 2 : 1
        const calls = (await f.provider.calls()).filter(call => call.method === 'turn/start'
          && String(call.correlationId).startsWith(`execution:${execution.id}`))
        expect(calls.map(call => call.correlationId)).toEqual([
          `execution:${execution.id}`,
          ...Array.from({ length: expectedRepairs }, (_, index) => `execution:${execution.id}:result-repair:${index + 1}`),
        ])
        expect(new Set(calls.map(call => call.threadId))).toEqual(new Set([execution.nativeSessionId]))
        if (kind !== 'handoff') expect(calls.map(call => call.outputSchema)).toEqual(calls.map(() => outputSchema))
        expect(execution.result).toMatchObject(kind === 'exhausted'
          ? { outcome: 'failed', error: { code: 'OUTPUT_SCHEMA_MISMATCH', retryable: false } }
          : { outcome: 'succeeded', output: { text: JSON.stringify(finalAnswer) } })
        expect((await f.db.pool.query('select attempt from execution_work_result_repairs where execution_id=$1 order by attempt',
          [execution.id])).rows).toEqual(Array.from({ length: expectedRepairs }, (_, index) => ({ attempt: index + 1 })))
        const readback = SavedRunDetailsSchema.parse(decodeMcpToolResult(await f.call('run_get', {
          ...scope, runId: started!.run.id, detail: 'full',
        }, reader.token)))
        expect(readback.executions[0]!.result).toEqual(execution.result)
      } finally { await f.close() }
    }, 240_000)
})
