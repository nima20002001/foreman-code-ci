import type { MaintenanceTask } from '@foreman-code/contracts/computer-maintenance'
import { expect, it } from 'vitest'
import { humanizeMaintenanceText, newestTaskPerKind } from './maintenanceText'

it.each([
  ['Unknown system error -122: Unknown system error -122, write', 'Disk quota exceeded'],
  ['EDQUOT: disk quota exceeded, write', 'Disk quota exceeded'],
  ['ENOSPC: no space left on device', 'Disk is full'],
  ['worker_update_restart_pending', 'Restarting to finish the update'],
  ['EACCES: permission denied, open', 'Permission denied'],
] as const)('says %s in plain words and keeps the raw text', (raw, text) => {
  expect(humanizeMaintenanceText(raw)).toEqual({ text, raw })
})

it('passes unknown text through unchanged', () => {
  expect(humanizeMaintenanceText('Package download failed')).toEqual({ text: 'Package download failed', raw: undefined })
})

function task(kind: MaintenanceTask['kind'], state: MaintenanceTask['state'], startedAt: string): MaintenanceTask {
  return { id: crypto.randomUUID(), kind, state, startedAt, finishedAt: startedAt, summary: `${kind} ${state}`, outputTail: '' }
}

it('keeps only the newest task of each kind, so a later success hides an earlier failure', () => {
  const kept = newestTaskPerKind([
    task('update-worker', 'failed', '2026-10-17T14:31:00.000Z'),
    task('update-harnesses', 'failed', '2026-10-09T08:00:00.000Z'),
    task('update-worker', 'succeeded', '2026-10-17T15:14:00.000Z'),
  ])
  expect(kept.map(value => `${value.kind}:${value.state}`)).toEqual(['update-worker:succeeded', 'update-harnesses:failed'])
})
