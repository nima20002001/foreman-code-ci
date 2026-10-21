import { expect, it } from 'vitest'
import { CiHostRequestSchema } from './ciHost.js'
import { CiRunInputSchema, OperatorCiRunInputSchema } from './ci.js'

it('accepts a full gate through the shared CI request contract', () => {
  const input = { suite: 'integration', scope: 'full', gate: true, commandId: 'gate', commit: 'a'.repeat(40) }
  expect(OperatorCiRunInputSchema.parse({ ...input, workspaceId: 'workspace' })).toMatchObject(input)
  expect(CiRunInputSchema.parse(input)).toMatchObject(input)
})

it('rejects gate flags on host jobs outside full integration', () => {
  const request = { operation: 'start', runId: '11111111-1111-4111-8111-111111111111',
    repository: 'octo/site', commit: 'a'.repeat(40), gate: true }
  for (const suite of ['typecheck', 'lint', 'unit']) {
    expect(CiHostRequestSchema.safeParse({ ...request, suite, scope: 'full' }).success).toBe(false)
  }
  expect(CiHostRequestSchema.safeParse({ ...request, suite: 'integration', scope: 'full',
    files: ['apps/api/test/site.integration.test.ts'], integrationShards: 12 }).success).toBe(true)
})

it('rejects gate requests that select only part of the gate', () => {
  for (const input of [
    { suite: 'unit', scope: 'full' },
    { suite: 'integration', scope: 'affected' },
    { suite: 'integration', scope: 'full', partitions: 2 },
    { suite: 'integration', scope: 'full', files: ['apps/api/test/site.integration.test.ts'] },
  ]) {
    expect(OperatorCiRunInputSchema.safeParse({ ...input, gate: true, commandId: 'gate', workspaceId: 'workspace' })
      .success).toBe(false)
  }
})

it('preserves and validates the saved build allowance on host starts', () => {
  const request = { operation: 'start', runId: '11111111-1111-4111-8111-111111111111',
    repository: 'octo/site', commit: 'a'.repeat(40), suite: 'integration', scope: 'full' }
  expect(CiHostRequestSchema.parse({ ...request, buildAllowancePercent: 50 }))
    .toMatchObject({ buildAllowancePercent: 50 })
  for (const buildAllowancePercent of [0, 101, 50.5]) {
    expect(CiHostRequestSchema.safeParse({ ...request, buildAllowancePercent }).success).toBe(false)
  }
})
