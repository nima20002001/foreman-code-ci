import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { describe, expect, it, vi } from 'vitest'
import { AgentConfigurationVersionSchema } from '@foreman-code/contracts'
import { ExecutableWorkflowV3Schema, WorkflowVersionV3Schema } from '@foreman-code/contracts/wave25'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'
import { reviewerScopeFixture, unsupportedReviewerScopes } from './helpers/eng07ReviewAdmission.testSupport.js'
import { transports } from './helpers/eng07SaveAdmission.testSupport.js'
import { code, counts, rejected } from './helpers/reviewerScopeAdmission.js'

for (const transport of transports) describe.skipIf(!postgresEnabled)(`ENG07 reviewer scope HTTP/MCP admission: ${transport}`, () => {
  it.each(unsupportedReviewerScopes)('%s cannot Start a version accepted before this validator fix', async (kind) => {
    const f = await currentOperatorIntegration({ approvalNodeIds: [] })
    try {
      const historical = reviewerScopeFixture(kind)
      const shape = z.object({ version: WorkflowVersionV3Schema, configurations: z.array(AgentConfigurationVersionSchema) }).strict()
      const safeParse = ExecutableWorkflowV3Schema.safeParse.bind(ExecutableWorkflowV3Schema)
      let legacyParses = 0
      // Setup ONLY: emulate the old validator's single omission while retaining
      // every other executable check and the REAL typed Save/publication writer.
      // No SQL evidence/receipt forging. Restore BEFORE either Start transport.
      const legacyValue = (raw: unknown) => {
        const result = safeParse(raw)
        if (result.success) return result.data
        expect(result.error.issues).toHaveLength(1)
        expect(result.error.issues[0]!.message).toContain(code)
        const value = shape.parse(raw)
        expect(value.version.workspaceId).toBe(historical.scope.workspaceId)
        legacyParses++
        return value
      }
      const oldValidator = vi.spyOn(ExecutableWorkflowV3Schema, 'parse').mockImplementation(legacyValue)
      const oldSafeValidator = vi.spyOn(ExecutableWorkflowV3Schema, 'safeParse').mockImplementation((raw) => ({
        success: true, data: legacyValue(raw),
      }))
      try { await seedAgent3(f.db.pool, f.db.directory, historical, { run: false }) }
      finally { oldSafeValidator.mockRestore(); oldValidator.mockRestore() }
      expect(legacyParses).toBeGreaterThan(0)
      expect(ExecutableWorkflowV3Schema.safeParse({ version: historical.version, configurations: historical.configurations }).success).toBe(false)
      const row = (await f.db.pool.query('select revision::text from workflows where id=$1', [historical.scope.workflowId])).rows[0]!
      const input = { workspaceId: historical.scope.workspaceId, workflowId: historical.scope.workflowId,
        workflowVersionId: historical.version.id, executionSemanticsVersion: 3, commandId: randomUUID(),
        expectedWorkflowRevision: Number(row.revision), expectedAgentConfigurationVersionIds: historical.version.agentConfigurationVersionIds,
        expectedLocationRevision: 1, input: {} }
      await rejected(f, transport, 'run_start', `/api/management/workspaces/${input.workspaceId}/workflows/${input.workflowId}/runs`, 'POST', input)
      expect(await counts(f, input.workflowId)).toEqual({ versions: 1, runs: 0 })
      expect(f.provider.counts.sessions).toBe(0); expect(f.provider.counts.starts).toBe(0)
      expect((await f.db.pool.query(`select 1 from management_command_receipts where principal_id=$1
        and operation='run.start' and command_id=$2`, [f.writer.principal.id, input.commandId])).rows).toEqual([])
    } finally { await f.close() }
  }, 60000)
})
