import { expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { JobDefinitionRecordSchema } from '@foreman-code/contracts/job-verification'
import { buildComputerFixture } from '../../../test/helpers/buildComputerFixture.js'
import { BuildComputerSettings, buildComputerKey } from '../settings/buildComputers.js'
import type { WorkerExecutionPolicy } from '../settings/workerExecution.js'
import { JobComputerSelection } from './computerSelection.js'
import type { JobSql } from './repository.js'

it.each([true, false])('reads host settings once for several profiles when enrollment enabled is %s', async enabled => {
  const f = buildComputerFixture('11111111-1111-4111-8111-111111111111', 'workspace')
  const candidate = { ...f.candidate, ready: false, reasons: ['runtime_setup_required'] }
  const candidates = [candidate, candidate, candidate]
  const query = vi.fn(async (text: string) => {
    if (text.includes('from build_computer_preferences')) return { rowCount: 1, rows: [{
      host_key: buildComputerKey(f.target), target: f.target, revision: '1', build_enabled: true,
      build_priority: 50, build_allowance_percent: 100,
    }] }
    if (text.includes('from ci_enrollment_computers')) return { rowCount: 1, rows: [{
      host_key: buildComputerKey(f.target), enabled,
    }] }
    return { rowCount: 0, rows: [] }
  })
  const settings = new BuildComputerSettings({} as never, {} as never, vi.fn())
  const selection = new JobComputerSelection(settings,
    { candidates: async () => ({ candidates, diagnosticCodes: [] }) }, {} as WorkerExecutionPolicy)
  const definition = JobDefinitionRecordSchema.parse({ schemaVersion: 1, id: 'definition', versionId: 'version',
    workspaceId: 'workspace', name: 'Placement', revision: 1, spec: f.auto,
    createdAt: f.candidate.profile.createdAt, updatedAt: f.candidate.profile.updatedAt })

  const result = await selection.claim({ query } as unknown as JobSql, {} as ManagementPrincipal, definition,
    { executionId: 'execution', attemptId: 'attempt', operationId: 'operation' })

  expect(result).toMatchObject({ spec: null, compatibleTargetCount: enabled ? 1 : 0,
    reasons: enabled ? ['runtime_setup_required'] : ['disabled'] })
  expect(query).toHaveBeenCalledTimes(5)
})
