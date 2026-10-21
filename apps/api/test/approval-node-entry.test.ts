import { expect, it } from 'vitest'
import { DEFAULT_CODEX_ADVANCED_CONFIGURATION } from '@foreman-code/contracts'
import { ExecutableWorkflowV3Schema, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'

it('requires explicit V3 approval authority before a node can enter native work', () => {
  const fixture = makeCurrentWorkflowFixture('approval-entry', 'single')
  expect(ExecutableWorkflowV3Schema.safeParse({ configurations: fixture.configurations,
    version: { ...fixture.version, approval: undefined,
      definition: { ...fixture.version.definition, approval: undefined } } }).success).toBe(false)
})

it('preserves an explicit never-ask native policy within the same V3 workflow contract', () => {
  const fixture = makeCurrentWorkflowFixture('never-ask-entry', 'single')
  const configuration = fixture.configurations[0]!
  if (configuration.harness.harness !== 'codex') throw new Error('Codex fixture required')
  configuration.harness.advanced = { ...DEFAULT_CODEX_ADVANCED_CONFIGURATION, approvalPolicy: 'never' }
  const accepted = ExecutableWorkflowV3Schema.parse({ version: fixture.version, configurations: fixture.configurations })
  expect(accepted.version.executionSemanticsVersion).toBe(3)
  expect(accepted.version.approval).toEqual({ handler: 'user' })
  expect(accepted.configurations[0]!.harness).toMatchObject({ advanced: { approvalPolicy: 'never' } })
  expect(accepted.version.definition).not.toHaveProperty('repeat')
})
