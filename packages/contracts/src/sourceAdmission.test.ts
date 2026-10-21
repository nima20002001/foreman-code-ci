import { describe, expect, it } from 'vitest'
import { SourceApproveInputSchema } from './sourceAdmission.js'

const input = {
  workspaceId: 'workspace-owned',
  commandId: 'approve-source-command',
  expectedLocationRevision: 1,
  commit: 'a'.repeat(40),
  executablePolicy: 'strip',
}

describe('tracked source capture', () => {
  it('accepts capture without a path approval choice', () => {
    expect(SourceApproveInputSchema.parse(input)).toEqual(input)
  })

  it('accepts revision zero for repository capture before a workspace folder is configured', () => {
    expect(SourceApproveInputSchema.parse({ ...input, expectedLocationRevision: 0 })
      .expectedLocationRevision).toBe(0)
  })

  it.each([-1, 0.5])('rejects invalid location revision %s', expectedLocationRevision => {
    expect(SourceApproveInputSchema.safeParse({ ...input, expectedLocationRevision })
      .success).toBe(false)
  })

  it.each([
    { approvedPaths: ['src/app.ts'] },
    { approveTrackedTree: true },
  ])('rejects removed approval fields: %j', choice => {
    expect(SourceApproveInputSchema.safeParse({ ...input, ...choice }).success).toBe(false)
  })
})
