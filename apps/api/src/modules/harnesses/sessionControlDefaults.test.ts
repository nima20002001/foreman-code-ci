import { expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, RETIRED_OPENCODE_MESSAGE } from '@foreman-code/contracts'
import { pendingSessionControls } from './sessionControlDefaults.js'
it('offers first-turn Plan without claiming native application or model capacity', () => {
  const controls = pendingSessionControls(DEFAULT_HARNESS_DEFAULTS.codex)
  expect(controls.plan.supported).toBe(true)
  expect(controls.plan.reason).toContain('first native message')
  expect(controls.modelCapacity).toBeNull()
  expect(controls.contextBudgets).toEqual([])
})

it('offers no controls for a retired saved harness', () => {
  const configuration = { harness: 'opencode' as const, model: 'historical-model',
    variant: '', nativeAgent: 'build', thinking: true, autoApprove: true }
  expect(pendingSessionControls(configuration)).toMatchObject({
    compact: { supported: false, reason: RETIRED_OPENCODE_MESSAGE },
    plan: { supported: false, reason: RETIRED_OPENCODE_MESSAGE },
    autoCompact: { supported: false, reason: RETIRED_OPENCODE_MESSAGE },
    autoCompactBudget: { supported: false, reason: RETIRED_OPENCODE_MESSAGE },
    modelCapacity: null,
    contextBudgets: [],
  })
})
