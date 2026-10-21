import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { toolFailure } from '../src/mcp/shared/results.js'
import { ExecutableWorkflowV3Schema, WorkflowDefinitionV3Schema } from '@foreman-code/contracts/wave25'
import { reviewerScopeFixture, supportedReviewerScopes, unsupportedReviewerScopes } from './helpers/eng07ReviewAdmission.testSupport.js'

const code = 'REPEAT_REVIEW_SCOPE_UNSUPPORTED'
describe('ENG07 executable App reviewer/repeat scope admission', () => {
  it.each(unsupportedReviewerScopes)('rejects %s before native execution', (kind) => {
    const f = reviewerScopeFixture(kind)
    // The editable definition remains representable. It cannot be executable.
    expect(WorkflowDefinitionV3Schema.safeParse(f.version.definition).success).toBe(true)
    const result = ExecutableWorkflowV3Schema.safeParse({ version: f.version, configurations: f.configurations })
    expect(result.success).toBe(false)
    if (result.success) throw new Error('Unsupported reviewer assignment was admitted')
    const index = f.version.definition.edges.findIndex((edge) => edge.kind === 'approval')
    expect(result.error.issues).toHaveLength(1)
    expect(result.error.issues[0]).toMatchObject({ code: 'custom', path: ['version', 'definition', 'edges', index],
      message: expect.stringContaining(code) })
    expect(result.error.issues[0]!.message).toContain('same repeat block')
    const reply = toolFailure(result.error)
    expect(reply.isError).toBe(true)
    expect(reply.structuredContent).toBeUndefined()
    const text = reply.content.find((item) => item.type === 'text')
    if (!text || text.type !== 'text') throw new Error('MCP failure must retain its text error body')
    expect(JSON.parse(text.text)).toEqual({ error: { code: 'INVALID_REQUEST',
      message: 'The request does not match its shared contract.',
      details: { issues: result.error.issues.map((issue) => ({ path: issue.path, message: issue.message })) } } })
    expect(text.text).not.toContain(f.version.id)
    expect(text.text).not.toContain(f.configurations[0]!.id)
  })

  it('does not disclose arbitrary private schema issues through the MCP error boundary', () => {
    const schema = z.unknown().superRefine((_value, context) => {
      context.addIssue({ code: 'custom', path: ['private-configuration'], message: 'PRIVATE-EVIDENCE-CANARY' })
    })
    const result = schema.safeParse(null)
    if (result.success) throw new Error('Expected the private fixture issue')
    const reply = toolFailure(result.error)
    expect(reply.isError).toBe(true)
    expect(JSON.stringify(reply)).toContain('INTERNAL_ERROR')
    expect(JSON.stringify(reply)).not.toContain('PRIVATE-EVIDENCE-CANARY')
    expect(JSON.stringify(reply)).not.toContain('private-configuration')
  })

  it.each(supportedReviewerScopes)('keeps %s executable without a compatibility mode', (kind) => {
    const f = reviewerScopeFixture(kind)
    const result = ExecutableWorkflowV3Schema.parse({ version: f.version, configurations: f.configurations })
    expect(result.version).toEqual(f.version)
    expect(result.version.executionSemanticsVersion).toBe(3)
    expect(Object.hasOwn(result.version.definition, 'repeat')).toBe(kind !== 'ordinary')
  })
})
