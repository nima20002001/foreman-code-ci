import { describe, expect, it } from 'vitest'
import { createChatVisit, sameSelectedTarget } from './selectedRunChatModel'
import { execution } from './sch10.testSupport'

describe('historical chat identity', () => {
  it.each(['workspaceId', 'workflowId', 'runId', 'workflowNodeId', 'executionId'] as const)('rejects a different %s', (field) => {
    const target = execution('run-a')
    expect(sameSelectedTarget(target, target)).toBe(true)
    expect(sameSelectedTarget(target, { ...target, [field]: `${target[field]}-other` })).toBe(false)
  })
  it('drops captures across a disposed/remounted visit even when the Run again matches', () => {
    let selected = true
    const visit = createChatVisit(() => selected), close = visit.mount(), old = visit.capture()
    expect(old()).toBe(true)
    selected = false; expect(old()).toBe(false)
    close(); selected = true; const closeAgain = visit.mount()
    expect(old()).toBe(false)
    expect(visit.capture()()).toBe(true)
    closeAgain(); expect(visit.isCurrent()).toBe(false)
  })
})
