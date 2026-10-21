import { expect, it } from 'vitest'
import { CiComputerRefSchema, CiRunRecordSchema } from './ciHost.js'
import { ComputerActivityListSchema } from './computerActivity.js'
import { CircleSchedulingRoleSchema } from './circleCredits.js'
import { CircleAccountAddInputSchema, CircleAccountIdSchema, CircleAccountsSchema,
  CircleAccountReadSchema, DEFAULT_CIRCLE_ACCOUNTS } from './management/circleAccounts.js'

const legacy = { kind: 'cloud', mainId: 'fixture-main', provider: 'circleci', account: 'fixture-org', slot: 0 }
it('preserves old host references and saved run identities while separating login from org', () => {
  expect(CiComputerRefSchema.parse(legacy)).toEqual(legacy)
  const hostRef = { ...legacy, circleAccountId: 'reserve' }
  expect(CiComputerRefSchema.parse(hostRef)).toEqual(hostRef)
  expect(CiComputerRefSchema.safeParse({ ...hostRef, provider: 'github' }).success).toBe(false)
  const record = {
    id: '11111111-1111-4111-8111-111111111111', workspaceId: 'workspace', suite: 'unit', commit: 'a'.repeat(40),
    repository: 'fixture-org/fixture-repo',
    partition: null, groupId: '11111111-1111-4111-8111-111111111111', state: 'running',
    computer: { hostRef: legacy, label: 'CircleCI' }, step: null, exitCode: null, message: null,
    queuedAt: '2026-10-01T00:00:00Z', startedAt: null, finishedAt: null,
    initiator: { principalId: 'fixture-owner', executionId: null },
    executionHistory: [{ runId: '22222222-2222-4222-8222-222222222222', hostRef: legacy }],
  }
  expect(CiRunRecordSchema.parse(record).computer?.hostRef).toEqual(legacy)
  expect(CiRunRecordSchema.parse({ ...record, computer: { ...record.computer, hostRef } })
    .computer?.hostRef).toEqual(hostRef)
})
it('round trips safe account IDs and fixed roles without accepting credential metadata', () => {
  for (const id of ['default', 'reserve', 'ci-2']) expect(CircleAccountIdSchema.parse(id)).toBe(id)
  for (const id of ['../escape', 'with:colon', 'UPPER', '']) expect(CircleAccountIdSchema.safeParse(id).success).toBe(false)
  for (const role of ['active', 'standby', 'exhausted']) expect(CircleSchedulingRoleSchema.parse(role)).toBe(role)
  const account = { id: 'reserve', label: 'Reserve', role: 'standby',
    organizations: ['fixture-delta', 'fixture-echo', 'fixture-foxtrot'] }
  expect(CircleAccountAddInputSchema.parse({ account })).toEqual({ account, commandId: expect.any(String) })
  expect(CircleAccountAddInputSchema.safeParse({ account, token: 'fixture-canary' }).success).toBe(false)
  expect(CircleAccountAddInputSchema.safeParse({ account: { ...account, role: 'primary' } }).success).toBe(false)
  expect(CircleAccountsSchema.parse({ accounts: [...DEFAULT_CIRCLE_ACCOUNTS.accounts, account] })
    .accounts[1]).toEqual(account)
  expect(JSON.stringify(CircleAccountAddInputSchema.parse({ account }))).not.toContain('token')
  expect(CircleAccountsSchema.safeParse({ accounts: [
    { ...DEFAULT_CIRCLE_ACCOUNTS.accounts[0], organizations: ['fixture-alpha', 'fixture-bravo', 'fixture-charlie'] },
    { ...account, organizations: ['FIXTURE-ALPHA', 'fixture-echo', 'fixture-foxtrot'] },
  ] }).success).toBe(false)
})

it('accepts draining cloud aliases with zero schedulable slots while rejecting invalid slot counts', () => {
  const activity = {
    mainId: '11111111-1111-4111-8111-111111111111', computers: [], truncated: false, activityComplete: true,
    cloud: [{ provider: 'circleci', name: 'Fixture legacy executor', ready: true, slots: 0, running: 1 }],
  }
  expect(ComputerActivityListSchema.parse(activity)).toEqual(activity)
  for (const slots of [-1, 0.5]) {
    expect(ComputerActivityListSchema.safeParse({
      ...activity, cloud: [{ ...activity.cloud[0], slots }],
    }).success).toBe(false)
  }
})

it.each([1, 2, 4])('reads %s discovered primary organizations while preserving explicit registration limits', count => {
  const owners = Array.from({ length: count }, (_, index) => `fixture-org-${index}`)
  const account = { id: 'default', label: 'Primary', role: 'primary', organizations: [] }
  const reading = { ...account, tokenConfigured: true, ready: true, reasons: [], orgs: owners.map(owner => ({
    account: owner, circleAccountId: 'default', ready: true, running: 0,
    schedulingRole: 'active', schedulingReason: 'Primary capacity.', credits: null,
  })) }
  expect(CircleAccountReadSchema.parse(reading)).toEqual(reading)
  expect(CircleAccountAddInputSchema.parse({ account }).account).toEqual(account)
  expect(CircleAccountAddInputSchema.safeParse({ account: { ...account, organizations: owners } }).success).toBe(false)
  expect(CircleAccountReadSchema.safeParse({ ...reading, organizations: owners }).success).toBe(false)
})
