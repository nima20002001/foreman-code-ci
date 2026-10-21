import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  BugReportCloseResultSchema,
  BugReportCreateResultSchema,
  BugReportPageSchema,
  BugReportSchema,
  BugReportUpdateResultSchema,
  type BugReportCreateInput,
  type ManagementGrant,
} from '@foreman-code/contracts/management'
import { buildApp } from '../src/app.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresLocalHumanAccess } from '../src/modules/access/localHuman.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { BugReportService } from '../src/modules/bug-reports/service.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { bugReportsMigration } from '../src/infrastructure/bugReportsMigration.js'
import { bugReportLifecycleMigration } from '../src/infrastructure/bugReportLifecycleMigration.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'

let database: Awaited<ReturnType<typeof currentDatabase>>
const resources: Array<() => Promise<void>> = []

beforeAll(async () => { database = await currentDatabase() }, 60_000)
afterAll(async () => { await database.close() }, 60_000)
afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close()
})

async function fixture(pool = database.pool) {
  const workspaceId = `workspace-${randomUUID()}`
  const otherWorkspaceId = `workspace-${randomUUID()}`
  await pool.query('insert into workspaces(id,record) values($1,\'{}\'),($2,\'{}\')',
    [workspaceId, otherWorkspaceId])
  const access = new PostgresAccessService(pool)
  const commands = new PostgresCommandCoordinator(pool)
  const bugReports = new BugReportService(pool, commands)
  const services = { bugReports, commands } as unknown as OperatorServices
  const app = buildApp({
    logger: false,
    localHuman: new PostgresLocalHumanAccess(pool, access),
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services },
  })
  resources.push(() => app.close())
  const issue = async (grants: ManagementGrant[], name = 'Bug reporter') => access.issue({
    name, audience: 'operator', expiresAt: new Date(Date.now() + 300_000), grants,
  })
  const owner = await issue([{ actions: ['bug_reports:report', 'bug_reports:read', 'bug_reports:update'], scope: {} }])
  const request = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>, token = owner.token) => app.inject({
    method, url, headers: { authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { payload }),
  })
  const input = (overrides: Partial<BugReportCreateInput> = {}): BugReportCreateInput => ({
    commandId: `report-${randomUUID()}`,
    workspaceId,
    title: 'Context request failed',
    tried: { feature: 'context_get', inputsSummary: 'Read the current context.' },
    happened: { errorCode: 'CONTEXT_UNAVAILABLE', message: 'The saved context was unavailable.' },
    expected: 'Return the context.',
    severity: 'high',
    ...overrides,
  })
  return { app, access, bugReports, owner, issue, request, input, workspaceId, otherWorkspaceId }
}

describe('bug report HTTP persistence', () => {
  it('preserves populated pre-lifecycle reports and matches their migrated titles on repeat', async () => {
    const upgrading = await currentDatabase({ beforeMigration: bugReportLifecycleMigration.version })
    try {
      const f = await fixture(upgrading.pool)
      const saved = []
      for (const status of ['triaged', 'fixed'] as const) {
        const content: Partial<BugReportCreateInput> = { ...f.input({ title: `Legacy   ${status} failure` }) }
        delete content.commandId
        const report = BugReportSchema.parse({
          ...content, id: `bug-report-${randomUUID()}`, status, revision: 2, occurrenceCount: 2,
          reporter: { principalId: f.owner.principal.id, name: f.owner.principal.name, audience: 'operator' },
          harness: null, createdAt: '2026-10-10T10:00:00.000Z', updatedAt: '2026-10-11T10:00:00.000Z',
          lastReportedAt: '2026-10-11T10:00:00.000Z',
        })
        await upgrading.pool.query(
          `insert into bug_reports(id,workspace_id,fingerprint,status,severity,revision,record,created_at)
           values($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
          [report.id, report.workspaceId, randomUUID(), report.status, report.severity,
            report.revision, JSON.stringify(report), report.createdAt],
        )
        saved.push(report)
      }
      await applyApplicationMigrations(upgrading.pool)
      await applyApplicationMigrations(upgrading.pool)
      for (const original of saved) {
        expect(await f.bugReports.get(f.owner.principal, original.id)).toEqual(original)
        const repeated = await f.bugReports.report(f.owner.principal, 'http',
          f.input({ title: original.title.toUpperCase().replace(/ +/g, ' ') }))
        expect(repeated).toMatchObject({ deduplicated: true,
          outcome: original.status === 'fixed' ? 'reopened' : 'repeat',
          report: { id: original.id, status: original.status === 'fixed' ? 'open' : 'triaged',
            occurrenceCount: 3, revision: 3, tried: original.tried, happened: original.happened } })
      }
    } finally { await upgrading.close() }
  })

  it('returns only a summary for another reporter and strips old full-report command receipts on replay', async () => {
    const f = await fixture()
    const original = BugReportSchema.parse(BugReportCreateResultSchema.parse((await f.request(
      'POST', '/api/management/bug-reports', f.input(),
    )).json()).report)
    const reporter = await f.issue([{ actions: ['bug_reports:report'], scope: { workspaceIds: [f.workspaceId] } }])
    const input = f.input()
    const response = await f.request('POST', '/api/management/bug-reports', input, reporter.token)
    expect(response.statusCode).toBe(200)
    const repeat = BugReportCreateResultSchema.parse(response.json())
    const summary = { id: original.id, status: original.status, title: original.title }
    expect(repeat.report).toEqual(summary)
    const saved = await f.bugReports.get(f.owner.principal, original.id)
    expect(saved).toMatchObject({ occurrenceCount: 2, revision: 2 })
    await database.pool.query(
      `update management_command_receipts set result=$2::jsonb
       where principal_id=$1 and operation='bug_reports.report'`,
      [reporter.principal.id, JSON.stringify({ report: saved, deduplicated: true })],
    )
    const replay = BugReportCreateResultSchema.parse((await f.request(
      'POST', '/api/management/bug-reports', input, reporter.token,
    )).json())
    expect(replay.report).toEqual(summary)
    expect(replay.replayed).toBe(true)
    expect(replay).toMatchObject({ outcome: 'repeat', message: expect.stringContaining(original.id) })
    expect(await f.bugReports.get(f.owner.principal, original.id)).toEqual(saved)
  })

  it('deduplicates repeated reports, replays commands, and reads saved status with revision conflicts', async () => {
    const f = await fixture()
    const input = f.input()
    const created = await f.request('POST', '/api/management/bug-reports', input)
    expect(created.statusCode).toBe(201)
    const initial = BugReportCreateResultSchema.parse(created.json())
    expect(initial).toMatchObject({ deduplicated: false, replayed: false, report: {
      workspaceId: f.workspaceId, status: 'open', revision: 1, occurrenceCount: 1,
      reporter: { principalId: f.owner.principal.id, name: 'Bug reporter', audience: 'operator' }, harness: null,
    } })
    const replay = BugReportCreateResultSchema.parse((await f.request('POST', '/api/management/bug-reports', input)).json())
    expect(replay).toEqual({ ...initial, replayed: true })
    const repeat = BugReportCreateResultSchema.parse((await f.request('POST', '/api/management/bug-reports', {
      ...input, commandId: `report-${randomUUID()}`,
    })).json())
    expect(repeat).toMatchObject({ deduplicated: true, replayed: false,
      report: { id: initial.report.id, occurrenceCount: 2, revision: 2 } })
    const update = { commandId: `status-${randomUUID()}`, expectedRevision: 2, status: 'triaged' }
    const url = `/api/management/bug-reports/${initial.report.id}/status`
    const changed = BugReportUpdateResultSchema.parse((await f.request('POST', url, update)).json())
    expect(changed.report).toMatchObject({ status: 'triaged', revision: 3, occurrenceCount: 2 })
    expect(BugReportUpdateResultSchema.parse((await f.request('POST', url, update)).json()).replayed).toBe(true)
    const conflict = await f.request('POST', url, { ...update, commandId: `status-${randomUUID()}` })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } })
    expect((await f.request('POST', url, { ...update, status: 'open' })).statusCode).toBe(409)
    const persistedService = new BugReportService(database.pool, new PostgresCommandCoordinator(database.pool))
    expect(await persistedService.get(f.owner.principal, initial.report.id)).toEqual(changed.report)
    const readback = BugReportSchema.parse((await f.request('GET', url.replace('/status', ''))).json())
    expect(readback).toEqual(changed.report)
    const audit = await database.pool.query<{ action: string; outcome: string }>(
      'select action,outcome from management_audit where principal_id=$1 order by sequence', [f.owner.principal.id],
    )
    expect(audit.rows).toEqual(expect.arrayContaining([
      { action: 'bug_reports.report', outcome: 'succeeded' },
      { action: 'bug_reports.update', outcome: 'succeeded' },
      { action: 'bug_reports.update', outcome: 'failed' },
    ]))
  })

  it('redacts credentials from every report field and saved receipts, including escaped JSON and secret command IDs', async () => {
    const f = await fixture()
    const secret = 'sk-exampleConfidentialValue12345'
    const token = `opm_${'a'.repeat(43)}`
    const reporter = await f.issue([{ actions: ['bug_reports:report', 'bug_reports:read'], scope: {} }], `Reporter ${secret}`)
    const input = f.input({
      commandId: `command Bearer ${token}`,
      title: `API failed ${secret}`,
      tried: {
        feature: `context_get ${token}`,
        inputsSummary: '{"api_key":"hidden-password"} https://user:pass@example.test --api-key "cli hidden phrase"',
      },
      happened: { errorCode: `Bearer ${token}`, message: `password="hidden phrase" ${secret}` },
      expected: 'Return context with "token=\\u0068idden-value" removed. -----BEGIN PRIVATE KEY-----\nprivate-material',
    })
    const response = await f.request('POST', '/api/management/bug-reports', input, reporter.token)
    expect(response.statusCode).toBe(201)
    const safe = BugReportCreateResultSchema.parse(response.json())
    expect(JSON.stringify(safe)).toContain('[REDACTED]')
    const storage = await database.pool.query<{ value: unknown }>(
      `select record as value from bug_reports where id=$1 union all
       select to_jsonb(receipt) as value from management_command_receipts receipt where principal_id=$2 union all
       select to_jsonb(audit) as value from management_audit audit where principal_id=$2`,
      [safe.report.id, reporter.principal.id],
    )
    const serialized = JSON.stringify(storage.rows)
    const confidentialValues = [secret, token, 'hidden-password', 'hidden phrase', 'hidden-value',
      'user:pass', 'cli hidden phrase', 'private-material']
    for (const confidential of confidentialValues) {
      expect(serialized).not.toContain(confidential)
    }
    expect((await f.request('POST', '/api/management/bug-reports', input, reporter.token)).json().replayed).toBe(true)
    const changedSecret = { ...input, title: input.title.replace(secret, 'sk-anotherConfidentialValue12345') }
    const conflict = await f.request('POST', '/api/management/bug-reports', changedSecret, reporter.token)
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json()).toMatchObject({ error: { code: 'COMMAND_ID_CONFLICT' } })
  })

  it('deduplicates concurrent reports with equivalent case and whitespace', async () => {
    const f = await fixture()
    const input = f.input()
    const variants = ['Context request failed', 'CONTEXT REQUEST FAILED', 'Context  request\nfailed']
    const responses = await Promise.all(variants.map(title => f.request('POST', '/api/management/bug-reports', {
      ...input,
      title,
      commandId: `repeat-${randomUUID()}`,
    })))
    const reports = responses.map(response => BugReportCreateResultSchema.parse(response.json()))
    expect(new Set(reports.map(result => result.report.id)).size).toBe(1)
    expect(reports.filter(result => !result.deduplicated)).toHaveLength(1)
    const saved = BugReportSchema.parse((await f.request('GET',
      `/api/management/bug-reports/${reports[0]!.report.id}`)).json())
    expect(saved).toMatchObject({ occurrenceCount: 3, revision: 3 })
  })

  it('upgrades existing local human grants and retains reporting and triage after migration replay', async () => {
    const upgrading = await currentDatabase({ beforeMigration: bugReportsMigration.version })
    try {
      const access = new PostgresAccessService(upgrading.pool)
      const localHuman = new PostgresLocalHumanAccess(upgrading.pool, access)
      const seeded = await localHuman.current()
      const previousGrants = seeded.grants.map(grant => ({
        ...grant, actions: grant.actions.filter(action => !action.startsWith('bug_reports:')),
      }))
      await upgrading.pool.query('update management_principals set grants=$2::jsonb where id=$1',
        [seeded.id, JSON.stringify(previousGrants)])
      const before = await localHuman.current()
      expect(before.grants.flatMap(grant => grant.actions)).not.toContain('bug_reports:report')
      await applyApplicationMigrations(upgrading.pool)
      await applyApplicationMigrations(upgrading.pool)
      const f = await fixture(upgrading.pool)
      const created = await f.app.inject({
        method: 'POST', url: '/api/management/bug-reports', payload: f.input(),
      })
      expect(created.statusCode).toBe(201)
      const initial = BugReportCreateResultSchema.parse(created.json())
      const url = `/api/management/bug-reports/${initial.report.id}`
      const updated = await f.app.inject({ method: 'POST', url: `${url}/status`, payload: {
        commandId: `triage-${randomUUID()}`, expectedRevision: 1, status: 'triaged',
      } })
      expect(updated.statusCode).toBe(200)
      const readback = BugReportSchema.parse((await f.app.inject({ method: 'GET', url })).json())
      expect(readback).toMatchObject({ status: 'triaged', revision: 2, reporter: { audience: 'user' } })
    } finally {
      await upgrading.close()
    }
  })

  it('counts same-title reports from fresh delegated credentials and other owners in the workspace', async () => {
    const f = await fixture()
    const { configuration } = await new PostgresOperatorRepository(database.pool).ensure()
    const conversations = new PostgresOperatorConversationRepository(database.pool)
    async function reportingDelegate(ownerId = f.owner.principal.id) {
      const conversation = await conversations.create(configuration.operatorId, configuration, ownerId)
      const issued = await f.issue([{ actions: ['bug_reports:report'], scope: { workspaceIds: [f.workspaceId] } }])
      await database.pool.query('update management_principals set delegated_from=$2 where id=$1',
        [issued.principal.id, ownerId])
      await database.pool.query('insert into operator_chat_credentials(principal_id,conversation_id) values($1,$2)',
        [issued.principal.id, conversation.id])
      return issued
    }
    const firstDelegate = await reportingDelegate()
    const first = BugReportCreateResultSchema.parse((await f.request('POST', '/api/management/bug-reports',
      f.input(), firstDelegate.token)).json())
    expect(first.report).toMatchObject({ reporter: { principalId: firstDelegate.principal.id },
      harness: configuration.harness.harness })
    const nextDelegate = await reportingDelegate()
    const repeat = BugReportCreateResultSchema.parse((await f.request('POST', '/api/management/bug-reports',
      f.input(), nextDelegate.token)).json())
    expect(repeat).toMatchObject({ deduplicated: true })
    expect(repeat.report).toEqual({ id: first.report.id, status: first.report.status, title: first.report.title })
    expect(await f.bugReports.get(f.owner.principal, first.report.id)).toMatchObject({ occurrenceCount: 2 })
    const otherOwner = await f.issue([{ actions: ['bug_reports:report'], scope: { workspaceIds: [f.workspaceId] } }])
    const otherDelegate = await reportingDelegate(otherOwner.principal.id)
    const other = BugReportCreateResultSchema.parse((await f.request('POST', '/api/management/bug-reports',
      f.input(), otherDelegate.token)).json())
    expect(other).toMatchObject({ deduplicated: true, outcome: 'repeat' })
    expect(other.report).toEqual({ id: first.report.id, status: first.report.status, title: first.report.title })
    expect(await f.bugReports.get(f.owner.principal, first.report.id)).toMatchObject({ occurrenceCount: 3 })
    const distinct = BugReportCreateResultSchema.parse((await f.request('POST', '/api/management/bug-reports',
      f.input({ title: 'A different failure' }), otherDelegate.token)).json())
    expect(distinct).toMatchObject({ deduplicated: false, outcome: 'created' })
  })

  it('closes reports over HTTP into history and keeps them out of the default list', async () => {
    const f = await fixture()
    const created = BugReportSchema.parse(BugReportCreateResultSchema.parse((await f.request(
      'POST', '/api/management/bug-reports', f.input(),
    )).json()).report)
    const close = { commandId: `close-${randomUUID()}`, status: 'wont-fix', note: 'Works as designed',
      reports: [{ reportId: created.id, expectedRevision: created.revision }] }
    const reader = await f.issue([{ actions: ['bug_reports:read'], scope: { workspaceIds: [f.workspaceId] } }])
    const denied = await f.request('POST', '/api/management/bug-reports/close', close, reader.token)
    expect(denied.statusCode).toBe(403)
    const closed = BugReportCloseResultSchema.parse((await f.request('POST', '/api/management/bug-reports/close',
      close)).json())
    expect(closed.reports[0]).toMatchObject({ status: 'wont-fix', revision: created.revision + 1,
      resolution: { status: 'wont-fix', note: 'Works as designed' } })
    const active = BugReportPageSchema.parse((await f.request('GET',
      `/api/management/bug-reports?workspaceId=${f.workspaceId}`)).json())
    expect(active.items).toEqual([])
    const history = BugReportPageSchema.parse((await f.request('GET',
      `/api/management/bug-reports?workspaceId=${f.workspaceId}&view=history`)).json())
    expect(history.items).toEqual(closed.reports)
    const repeat = BugReportCreateResultSchema.parse((await f.request('POST', '/api/management/bug-reports',
      f.input())).json())
    expect(repeat).toMatchObject({ outcome: 'repeat', report: { id: created.id, status: 'wont-fix', occurrenceCount: 2 } })
    expect(repeat.message).toContain('wont-fix')
  })

  it('lists newest reports with filters and pagination while preserving each complete scoped grant', async () => {
    const f = await fixture()
    const reports = []
    for (const severity of ['low', 'critical', 'high'] as const) {
      reports.push(BugReportCreateResultSchema.parse((await f.request('POST', '/api/management/bug-reports',
        f.input({ severity, title: `Failure ${severity}` }))).json()).report)
    }
    const other = BugReportCreateResultSchema.parse((await f.request('POST', '/api/management/bug-reports',
      f.input({ workspaceId: f.otherWorkspaceId, title: 'Other workspace failure' }))).json()).report
    const reader = await f.issue([{ actions: ['bug_reports:read'], scope: { workspaceIds: [f.workspaceId] } }])
    const first = BugReportPageSchema.parse((await f.request('GET', '/api/management/bug-reports?limit=2', undefined,
      reader.token)).json())
    expect(first.items.map(report => report.id)).toEqual([reports[2]!.id, reports[1]!.id])
    expect(first.pageInfo.nextCursor).toBeTypeOf('string')
    const last = BugReportPageSchema.parse((await f.request('GET',
      `/api/management/bug-reports?limit=2&cursor=${first.pageInfo.nextCursor}`, undefined, reader.token)).json())
    expect(last.items.map(report => report.id)).toEqual([reports[0]!.id])
    expect(last.pageInfo.nextCursor).toBeNull()
    const filtered = BugReportPageSchema.parse((await f.request('GET',
      '/api/management/bug-reports?status=open&severity=critical', undefined, reader.token)).json())
    expect(filtered.items.map(report => report.id)).toEqual([reports[1]!.id])
    expect((await f.request('GET', `/api/management/bug-reports/${other.id}`, undefined, reader.token)).statusCode).toBe(403)
    const crossed = await f.issue([
      { actions: ['bug_reports:read'], scope: { workspaceIds: [f.workspaceId], runIds: ['different-run'] } },
      { actions: ['bug_reports:read'], scope: { workspaceIds: [f.otherWorkspaceId] } },
    ])
    const scoped = BugReportPageSchema.parse((await f.request('GET', '/api/management/bug-reports', undefined,
      crossed.token)).json())
    expect(scoped.items.map(report => report.id)).toEqual([other.id])
    const invalid = await f.request('GET', '/api/management/bug-reports?cursor=broken', undefined, reader.token)
    expect(invalid.statusCode).toBe(400)
  })

  it('denies read-only status updates and cross-workspace reports and rechecks live grants before replay', async () => {
    const f = await fixture()
    const input = f.input()
    const created = BugReportCreateResultSchema.parse((await f.request('POST', '/api/management/bug-reports', input)).json())
    const reader = await f.issue([{ actions: ['bug_reports:read'], scope: { workspaceIds: [f.workspaceId] } }])
    const denied = await f.request('POST', `/api/management/bug-reports/${created.report.id}/status`, {
      commandId: `denied-${randomUUID()}`, expectedRevision: 1, status: 'triaged',
    }, reader.token)
    expect(denied.statusCode).toBe(403)
    expect(denied.json()).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
    expect(await f.bugReports.get(f.owner.principal, created.report.id)).toEqual(created.report)
    const reporter = await f.issue([{ actions: ['bug_reports:report'], scope: { workspaceIds: [f.workspaceId] } }])
    expect((await f.request('POST', '/api/management/bug-reports', f.input({ workspaceId: f.otherWorkspaceId }),
      reporter.token)).statusCode).toBe(403)
    expect((await f.request('POST', '/api/management/bug-reports', {
      ...input, commandId: `forged-${randomUUID()}`, reporter: { name: 'Forged' },
    })).statusCode).toBe(400)
    await database.pool.query('update management_principals set grants=$2::jsonb where id=$1',
      [f.owner.principal.id, JSON.stringify([{ actions: ['bug_reports:read'], scope: {} }])])
    await expect(f.bugReports.report(f.owner.principal, 'http', input)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    const audits = await database.pool.query<{ outcome: string }>(
      'select outcome from management_audit where principal_id=$1', [reader.principal.id],
    )
    expect(audits.rows).toContainEqual({ outcome: 'denied' })
  })

  it('derives a local human reporter and accepts a workspace inferred from one reporting grant', async () => {
    const f = await fixture()
    const input = f.input()
    const response = await f.app.inject({ method: 'POST', url: '/api/management/bug-reports', payload: input })
    expect(response.statusCode).toBe(201)
    expect(BugReportSchema.parse(BugReportCreateResultSchema.parse(response.json()).report).reporter.audience).toBe('user')
    const reporter = await f.issue([{ actions: ['bug_reports:report'], scope: { workspaceIds: [f.workspaceId] } }])
    const unscoped = f.input({ title: 'Inferred workspace failure' })
    delete unscoped.workspaceId
    expect(BugReportSchema.parse(BugReportCreateResultSchema.parse((await f.request(
      'POST', '/api/management/bug-reports', unscoped, reporter.token,
    )).json()).report).workspaceId).toBe(f.workspaceId)
    expect((await f.request('POST', '/api/management/bug-reports', unscoped)).statusCode).toBe(400)
  })
})
