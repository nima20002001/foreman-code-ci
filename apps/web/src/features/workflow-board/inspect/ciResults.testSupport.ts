import type { CiRunJob, CiTestResults } from '@foreman-code/contracts'

export const ciResultJob: CiRunJob = {
  ticketId: '00000000-0000-4000-8000-000000000001', scope: 'affected', placement: 'host', message: null,
  tests: { passed: 1, failed: 1, skipped: 1 },
  requester: { executionId: 'agent-execution', agentId: 'agent-a', nodeId: 'coder', nodeName: 'Coder' },
  ci: { id: '00000000-0000-4000-8000-000000000001', groupId: '00000000-0000-4000-8000-000000000002',
    suite: 'unit', part: 'unit-web', partition: null, state: 'failed', exitCode: 1, computer: null, step: null,
    queuedAt: '2026-10-01T00:00:00.000Z', startedAt: null, finishedAt: null },
}

export const ciResultTests: CiTestResults = {
  summary: { passed: 1, failed: 1, skipped: 1 }, truncated: false,
  files: [{ file: 'apps/web/src/example.test.ts', status: 'failed', durationMs: 10, tests: [
    { name: 'passing example', status: 'passed', durationMs: 2 },
    { name: 'failing example', status: 'failed', durationMs: 3, message: 'Expected success' },
    { name: 'skipped example', status: 'skipped', durationMs: 0 },
  ] }],
}
