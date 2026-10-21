import { describe, expect, it } from 'vitest'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { CURRENT_WORKFLOW_TOOLS } from '@foreman-code/contracts/wave25'
import { unsupportedReviewerScopes } from './helpers/eng07ReviewAdmission.testSupport.js'
import { definitionUrl, transports } from './helpers/eng07SaveAdmission.testSupport.js'
import { candidate, counts, rejected } from './helpers/reviewerScopeAdmission.js'

for (const transport of transports) describe.skipIf(!postgresEnabled)(`ENG07 reviewer scope HTTP/MCP admission: ${transport}`, () => {
  it.each(unsupportedReviewerScopes)('%s is rejected at Validate and Save without publication', async (kind) => {
    const f = await currentOperatorIntegration({ approvalNodeIds: [] })
    try {
      const { input } = await candidate(f, kind)
      const { commandId, ...validation } = input; void commandId
      await rejected(f, transport, CURRENT_WORKFLOW_TOOLS.validate, `${definitionUrl(input)}/validate`, 'POST', validation)
      await rejected(f, transport, CURRENT_WORKFLOW_TOOLS.save, definitionUrl(input), 'PUT', input)
      expect(await counts(f, input.workflowId)).toEqual({ versions: 1, runs: 0 })
      expect((await f.db.pool.query('select current_version_id from workflows where id=$1', [input.workflowId])).rows[0]!.current_version_id)
        .toBe(input.expectedWorkflowVersionId)
      expect(f.provider.counts.sessions).toBe(0); expect(f.provider.counts.starts).toBe(0)
      expect((await f.db.pool.query(`select 1 from management_command_receipts where principal_id=$1
        and operation='workflow.save.v3' and command_id=$2`, [f.writer.principal.id, input.commandId])).rows).toEqual([])
    } finally { await f.close() }
  }, 60000)
})
