import { describe, expect, it } from 'vitest'
import { nextOccurrences, ScheduleConfigurationSchema, WorkflowScheduleSchema } from '@foreman-code/contracts/schedules'
import { planDueSchedule } from '../src/modules/schedules/dispatchPlan.js'

describe('elapsed seconds scheduler', () => {
  const configuration = { mode: 'interval' as const, unit: 'second' as const, every: 1,
    anchorAt: '2026-10-02T12:00:00.250Z', timezone: 'Asia/Tokyo', enabled: true, policy: 'latest_saved' as const }
  it('normalizes offset anchors, dispatches exact UTC instants and retains them after persistence/restart', () => {
    const parsed = ScheduleConfigurationSchema.parse({ ...configuration, anchorAt: '2026-10-02T21:00:00.250+09:00' })
    expect(parsed).toEqual(configuration)
    expect(nextOccurrences(parsed, '2026-10-02T12:00:00.250Z', 3)).toEqual([
      '2026-10-02T12:00:01.250Z', '2026-10-02T12:00:02.250Z', '2026-10-02T12:00:03.250Z',
    ])
    const saved = WorkflowScheduleSchema.parse(JSON.parse(JSON.stringify({ ...parsed, workspaceId: 'seconds-workspace',
      workflowId: 'seconds-workflow', revision: 1, nextOccurrenceAt: '2026-10-02T12:00:01.250Z' })))
    expect(planDueSchedule(saved, '2026-10-02T12:00:01.249Z')).toEqual([])
    expect(planDueSchedule(saved, '2026-10-02T12:00:01.250Z')).toEqual([
      { dueAt: '2026-10-02T12:00:01.250Z', decision: { status: 'eligible' }, nextDueAt: '2026-10-02T12:00:02.250Z' },
    ])
    expect(nextOccurrences({ ...parsed, timezone: 'America/New_York' }, '2026-10-02T12:00:00.250Z', 3))
      .toEqual(nextOccurrences(parsed, '2026-10-02T12:00:00.250Z', 3))
  })
  it('keeps only the latest due occurrence eligible within existing recovery batches', () => {
    let saved = WorkflowScheduleSchema.parse({ ...configuration, workspaceId: 'seconds-workspace', workflowId: 'seconds-workflow',
      revision: 1, nextOccurrenceAt: '2026-10-02T12:00:01.250Z' })
    const steps: ReturnType<typeof planDueSchedule> = []
    for (let pass = 0; pass < 3; pass++) {
      const batch = planDueSchedule(saved, '2026-10-02T12:04:11.900Z', 100)
      steps.push(...batch)
      saved = { ...saved, nextOccurrenceAt: batch.at(-1)!.nextDueAt }
    }
    expect(steps).toHaveLength(251)
    expect(steps.filter((step) => step.decision.status === 'eligible').map((step) => step.dueAt)).toEqual(['2026-10-02T12:04:11.250Z'])
    expect(saved.nextOccurrenceAt).toBe('2026-10-02T12:04:12.250Z')
  })
  it.each([0, -1, 0.5, Number.POSITIVE_INFINITY])('rejects invalid elapsed seconds %s', (every) => {
    expect(ScheduleConfigurationSchema.safeParse({ ...configuration, every }).success).toBe(false)
  })
})
