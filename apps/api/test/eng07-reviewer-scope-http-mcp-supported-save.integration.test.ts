import { describe, expect, it } from 'vitest'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { CURRENT_WORKFLOW_TOOLS, CurrentWorkflowSaveResultSchema,
  ExecutableWorkflowV3Schema } from '@foreman-code/contracts/wave25'
import { supportedReviewerScopes } from './helpers/eng07ReviewAdmission.testSupport.js'
import { definitionUrl, rpc, saveThrough, transports } from './helpers/eng07SaveAdmission.testSupport.js'
import { candidate, counts } from './helpers/reviewerScopeAdmission.js'
import { graphHeaders, graphRpcValue } from './eng04-graph-composition-fixture.js'

for (const transport of transports) describe.skipIf(!postgresEnabled)(`ENG07 reviewer scope HTTP/MCP admission: ${transport}`, () => {
  it.each(supportedReviewerScopes)('%s still validates and saves through the shared executable schema', async (kind) => {
    const f = await currentOperatorIntegration({ approvalNodeIds: [] })
    try {
      const { input, target } = await candidate(f, kind)
      const { commandId, ...validation } = input; void commandId
      if (transport === 'http') {
        const reply = await f.app.inject({ method: 'POST', url: `${definitionUrl(input)}/validate`, headers: graphHeaders(f.writer.token), payload: validation })
        expect(reply.statusCode, reply.body).toBe(200)
        expect(reply.json()).toMatchObject({ valid: true, executionSemanticsVersion: 3 })
      } else {
        const reply = await rpc(f, CURRENT_WORKFLOW_TOOLS.validate, validation)
        expect(reply.result?.isError, JSON.stringify(reply)).not.toBe(true)
        expect(graphRpcValue(reply.result as unknown as Parameters<typeof graphRpcValue>[0])).toMatchObject({ valid: true, executionSemanticsVersion: 3 })
      }
      const saved = CurrentWorkflowSaveResultSchema.parse(await saveThrough(f, transport, input))
      expect(saved.value.currentVersionId).not.toBe(input.expectedWorkflowVersionId)
      expect(ExecutableWorkflowV3Schema.parse({ version: saved.value.version, configurations: target.configurations }).version).toEqual(saved.value.version)
      expect(Object.hasOwn(saved.value.version.definition, 'repeat')).toBe(kind !== 'ordinary')
      expect(await counts(f, input.workflowId)).toEqual({ versions: 2, runs: 0 })
      expect(f.provider.counts.starts).toBe(0)
    } finally { await f.close() }
  }, 60000)
})
