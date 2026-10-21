import type pg from 'pg'
import { CI_FAILURE_HISTORY_LIMITS, CI_LOG_MAX_BYTES, CI_RUN_JOBS_LIMIT, CiListOutputSchema, CiRunRecordSchema,
  type CiFailureHistory, type CiGetInput, type CiListOutput, type CiRunRecord, type CiTestResults, type CiTestStatus,
  type OperatorCiListInput } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import { DomainError, databaseReadFailure } from '../errors.js'
import { CI_GET_ACTIONS, type CiAuthority } from '../jobs/ciAuthority.js'
import { ciGroupState } from './parts.js'
import { CI_QUEUE_ORDER, ciQueueReason } from './priority.js'
import { ciGateReport } from './gateReport.js'
import { RUN_CI_JOBS_SQL, runCiJob, storedCiTestResults, type RunCiJobRow } from './runJobs.js'
import type { HostCiComputer, HostCiEndpoint } from './serviceTypes.js'
import { readHostCiLog } from './logRead.js'
import { ciExecutionRunId } from './executionAttempt.js'
import { CiTicketChanges } from './ticketChanges.js'
import { ciGroupSharing } from './requestSharing.js'
import { missingCiTicket } from './missingTicket.js'
import { ciLogPage } from './logPage.js'
import { sanitizeCiText } from './text.js'
import { logIgnoredError } from '../diagnostics/ignoredError.js'

/** CI reads are idempotent: one retry after a lock or statement timeout, then a typed retryable error. */
export async function retryRead<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (databaseReadFailure(error) === error) throw error
    try {
      return await work()
    } catch (retryError) {
      throw databaseReadFailure(retryError)
    }
  }
}

/** Every server-side wait answers within this chunk, below the stdio bridge (120 s) and Worker relay (100 s) deadlines;
 * the bridge continues a group wait with further chunks. */
const CI_WAIT_CHUNK_SECONDS = 60
/** A ticket is settled when terminal and its results are no longer being collected. */
const ticketSettled = (run: CiRunRecord) => ['passed', 'failed', 'canceled', 'lost'].includes(run.state)
  && run.collection !== 'pending'
const chunkMs = (waitSeconds = 0) => Math.min(waitSeconds, CI_WAIT_CHUNK_SECONDS) * 1000

type HostRef = HostCiComputer['hostRef']
type TicketReadInput = CiGetInput & { workspaceId?: string | undefined }
interface CiReadHost {
  endpoint: HostCiEndpoint
  computer(hostRef: HostRef): Promise<HostCiComputer>
  smokeTargets(runs: CiRunRecord[]): Promise<Map<string, HostRef>>
}

/** Authorized ticket, test and log reads shared by HTTP and Operator MCP. */
export class HostCiReads {
  private readonly changes: CiTicketChanges

  constructor(private readonly pool: pg.Pool, private readonly authority: CiAuthority,
    private readonly host: CiReadHost) {
    this.changes = new CiTicketChanges(pool)
  }

  close() { this.changes.close() }

  async readTicket(caller: ManagementPrincipal, scope: Awaited<ReturnType<CiAuthority['resolve']>>,
    input: Pick<TicketReadInput, 'ticketId' | 'logTail'>) {
    let row: { record: unknown; log_tail: string } | undefined
    if (CiRunRecordSchema.shape.id.safeParse(input.ticketId).success) {
      row = (await this.pool.query<{ record: unknown; log_tail: string }>(
        `select record${input.logTail === false ? '' : ',log_tail'} from ci_runs where id=$1 and workspace_id=$2`,
        [input.ticketId, scope.workspaceId])).rows[0]
    }
    if (!row) throw await missingCiTicket(this.pool, input.ticketId, scope.workspaceId,
      { principalId: caller.id, executionId: scope.executionId ?? null })
    return row
  }

  private async queuePosition(id: string): Promise<number | undefined> {
    const rows = (await this.pool.query<{ id: string; position: number }>(`select id,position from
      (select id,row_number() over (order by ${CI_QUEUE_ORDER})::integer as position
        from ci_runs where state='queued') queue where id=$1`, [id])).rows
    return rows[0]?.position
  }

  async get(caller: ManagementPrincipal, input: TicketReadInput, signal?: AbortSignal) {
    signal?.throwIfAborted()
    if (input.waitUntil) return this.waitGroup(caller, input, signal)
    const initial = await this.snapshot(caller, input)
    if (!input.waitSeconds || !['queued', 'starting', 'running'].includes(initial.run.state)) return initial
    const watch = this.changes.subscribe(change => change.workspaceId === initial.run.workspaceId
      && change.ticketId === input.ticketId, signal)
    try {
      await watch.ready
      const seen = watch.version()
      // Read again after LISTEN is active so changes during subscription setup cannot be missed.
      const subscribed = await this.snapshot(caller, input)
      signal?.throwIfAborted()
      if (subscribed.run.state !== initial.run.state || subscribed.run.step !== initial.run.step) return subscribed
      await watch.changedSince(seen, chunkMs(input.waitSeconds))
      return await this.snapshot(caller, input)
    } finally {
      watch.close()
    }
  }

  /** Waits up to one chunk for every ticket of the group to settle; each read re-authorizes and re-resolves the ticket. */
  private async waitGroup(caller: ManagementPrincipal, input: TicketReadInput, signal?: AbortSignal) {
    const first = await this.groupReadout(caller, input)
    if (!input.waitSeconds || first.wait.status === 'settled') return first
    const deadline = Date.now() + chunkMs(input.waitSeconds)
    const { workspaceId, groupId } = first.run
    const watch = this.changes.subscribe(change => change.workspaceId === workspaceId && change.groupId === groupId, signal)
    try {
      await watch.ready
      for (;;) {
        const seen = watch.version()
        const current = await this.groupReadout(caller, input)
        const remaining = deadline - Date.now()
        if (current.wait.status === 'settled' || remaining <= 0) return current
        await watch.changedSince(seen, remaining)
      }
    } finally {
      watch.close()
    }
  }

  private async groupReadout(caller: ManagementPrincipal, input: TicketReadInput) {
    const snapshot = await this.snapshot(caller, input)
    const members = snapshot.partitions ?? [snapshot.run]
    const settledTickets = members.filter(ticketSettled).length
    return { ...snapshot, wait: { until: 'group-terminal' as const,
      status: settledTickets === members.length ? 'settled' as const : 'still-running' as const,
      tickets: members.length, settledTickets } }
  }

  private async snapshot(caller: ManagementPrincipal, input: TicketReadInput) {
    return retryRead(async () => {
      const scope = await this.authority.resolve(caller, input.workspaceId, CI_GET_ACTIONS)
      const row = await this.readTicket(caller, scope, input)
      const run = CiRunRecordSchema.parse(row.record)
      const groupRows = (await this.pool.query<{ record: unknown; log_tail: string; failed_files: string[] }>(
        `select record,array(select f->>'file' from jsonb_array_elements(test_results->'files') f
          where f->>'status'='failed') as failed_files
          ${input.logTail === false ? '' : ",case when id=$4 then log_tail else '' end as log_tail"}
          from ci_runs where group_id=$1 and workspace_id=$2
          and record->'initiator'=$3::jsonb
          order by record->>'suite',record->>'part',(record->'partition'->>'index')::integer,created_at,id`,
        [run.groupId, scope.workspaceId, JSON.stringify(run.initiator),
          ...(input.logTail === false ? [] : [run.id])])).rows.map(row => ({
          run: CiRunRecordSchema.parse(row.record), logTail: row.log_tail, failedFiles: row.failed_files ?? [],
        }))
      const group = groupRows.map(row => row.run)
      // Collection can finish between reads; pair the ticket and its log from the same group snapshot.
      const currentRow = groupRows.find(row => row.run.id === run.id) ?? { run, logTail: row.log_tail }
      const current = currentRow.run
      const groupState = ciGroupState(group)
      const position = current.state === 'queued' ? await this.queuePosition(current.id) : undefined
      const smokeComputer = (await this.host.smokeTargets([current])).get(current.groupId)
      const sharing = await ciGroupSharing(this.pool, scope.workspaceId, current.groupId)
      return { run: { ...current, ...(smokeComputer ? { smokeComputer } : {}) },
        partitions: group.length > 1 ? group : undefined,
        ...(input.logTail === false ? {} : { logTail: currentRow.logTail }),
        queue: position ? { position, reason: ciQueueReason(current) } : null,
        group: { groupId: current.groupId, state: groupState },
        ...(groupState === 'failed' ? { failedFiles: [...new Set(groupRows.flatMap(row => row.failedFiles))].sort() } : {}),
        ...(sharing ? { sharing } : {}),
        ...(current.gate ? { gate: ciGateReport(group) } : {}),
        ...(input.testStatus ? { tests: await this.testResults(run.id, scope.workspaceId, input.testStatus) } : {}),
        ...(current.state === 'failed' ? { failureHistory: await this.failureHistory(current.id, scope.workspaceId) } : {}) }
    })
  }

  /** How often each failed test of the ticket failed in the latest gate runs that ran its file. */
  private async failureHistory(id: string, workspaceId: string): Promise<CiFailureHistory[]> {
    const failed = (await this.testResults(id, workspaceId, ['failed']))?.files ?? []
    const entries: CiFailureHistory[] = []
    for (const file of failed.slice(0, 10)) {
      const rows = (await this.pool.query<{ status: string; tests: { name: string; status: string }[] }>(
        `select f->>'status' as status,f->'tests' as tests from (
          select test_results,created_at,id from ci_runs
          where workspace_id=$1 and id<>$2 and record->>'gate'='true' and state in ('passed','failed')
            and created_at > now() - make_interval(days => $4) and test_results->'files' @> $6::jsonb
          order by created_at desc,id desc limit $5
        ) r cross join lateral jsonb_array_elements(r.test_results->'files') f
          where f->>'file'=$3 order by r.created_at desc,r.id desc`,
        [workspaceId, id, file.file, CI_FAILURE_HISTORY_LIMITS.days, CI_FAILURE_HISTORY_LIMITS.runs,
          JSON.stringify([{ file: file.file }])])).rows
      const names = file.tests.length ? file.tests.map(test => test.name) : [null]
      for (const name of names) {
        const seen = name === null ? rows : rows.filter(row => row.tests.some(test => test.name === name))
        const failedRuns = name === null ? seen.filter(row => row.status === 'failed').length
          : seen.filter(row => row.tests.some(test => test.name === name && test.status === 'failed')).length
        entries.push({ file: file.file, test: name, failedRuns, runs: seen.length })
      }
    }
    return entries.slice(0, CI_FAILURE_HISTORY_LIMITS.entries)
  }

  /** The ticket's structured test results, limited to the given statuses; null until a finished test run reports them. */
  async tests(caller: ManagementPrincipal, input: { workspaceId?: string | undefined; ticketId: string
    status?: CiTestStatus[] | undefined }) {
    return retryRead(async () => {
      const scope = await this.authority.resolve(caller, input.workspaceId, CI_GET_ACTIONS)
      const row = await this.readTicket(caller, scope, { ticketId: input.ticketId, logTail: false })
      const run = CiRunRecordSchema.parse(row.record)
      return { ticketId: run.id, tests: await this.testResults(run.id, scope.workspaceId, input.status) }
    })
  }

  private async testResults(id: string, workspaceId: string, statuses?: CiTestStatus[]): Promise<CiTestResults | null> {
    const row = (await this.pool.query<{ test_results: unknown }>(
      'select test_results from ci_runs where id=$1 and workspace_id=$2', [id, workspaceId])).rows[0]
    return storedCiTestResults(row?.test_results, statuses)
  }

  /** Every CI ticket the Run's Agents requested, newest first, with the requesting Agent's node and test counts.
   * Agents read workspace tickets with ci_get; the Run-wide list is for the app and the Operator. */
  async list(caller: ManagementPrincipal,
    input: Omit<OperatorCiListInput, 'workspaceId'> & { workspaceId?: string | undefined }): Promise<CiListOutput> {
    return retryRead(async () => {
      if (caller.audience === 'worker') {
        throw new DomainError('ACCESS_DENIED', 'Agents read workspace CI tickets with ci_get; ci_list is Operator-only.', 403)
      }
      const scope = await this.authority.resolve(caller, input.workspaceId, CI_GET_ACTIONS)
      const run = (await this.pool.query<{ workflow_id: string }>('select workflow_id from runs where id=$1 and workspace_id=$2',
        [input.runId, scope.workspaceId])).rows[0]
      if (!run) throw new DomainError('RUN_NOT_FOUND', 'The Run was not found in this workspace.', 404)
      requireAuthorization(caller, 'runs:read', {
        workspaceId: scope.workspaceId, workflowId: run.workflow_id, runId: input.runId,
      })
      const rows = (await this.pool.query<RunCiJobRow>(RUN_CI_JOBS_SQL,
        [scope.workspaceId, input.runId, input.executionId ?? null])).rows
      return CiListOutputSchema.parse({ runId: input.runId, jobs: rows.slice(0, CI_RUN_JOBS_LIMIT).map(runCiJob),
        truncated: rows.length > CI_RUN_JOBS_LIMIT })
    })
  }

  /** Reads the run's log from its computer; without afterOffset it returns the last maxBytes. */
  async logs(caller: ManagementPrincipal, input: { workspaceId?: string | undefined; ticketId: string
    afterOffset?: number | undefined; maxBytes?: number | undefined; group?: boolean | undefined }) {
    return retryRead(async () => {
      const scope = await this.authority.resolve(caller, input.workspaceId, CI_GET_ACTIONS)
      const row = await this.readTicket(caller, scope, { ticketId: input.ticketId })
      const run = CiRunRecordSchema.parse(row.record)
      const maxBytes = Math.min(input.maxBytes ?? CI_LOG_MAX_BYTES, CI_LOG_MAX_BYTES)
      if (input.group) {
        const group = (await this.pool.query<{ record: unknown; log_tail: string }>(
          `select record,log_tail from ci_runs where group_id=$1 and workspace_id=$2
            and record->'initiator'=$3::jsonb order by created_at,id`,
          [run.groupId, scope.workspaceId, JSON.stringify(run.initiator)])).rows
        const partMaxBytes = Math.floor(maxBytes / group.length)
        const remainder = maxBytes % group.length
        const parts = await Promise.all(group.map(async (part, index) => {
          const record = CiRunRecordSchema.parse(part.record)
          return { run: record, ...await this.readLog(record, { afterOffset: input.afterOffset,
            maxBytes: partMaxBytes + Number(index < remainder) }, part.log_tail) }
        }))
        const own = parts.find(part => part.run.id === run.id)!
        return { text: own.text, nextOffset: own.nextOffset, logBytes: own.logBytes, maxBytes, parts,
          ...(own.source ? { source: own.source } : {}) }
      }
      if (!run.computer) throw new DomainError('CI_NOT_STARTED', 'This CI run is still queued.', 409)
      return this.readLog(run, { afterOffset: input.afterOffset, maxBytes }, row.log_tail)
    })
  }

  private async readLog(run: CiRunRecord,
    input: { afterOffset?: number | undefined; maxBytes?: number | undefined }, savedTail: string) {
    const maxBytes = input.maxBytes ?? CI_LOG_MAX_BYTES
    if (!run.computer) return { text: '', nextOffset: 0, logBytes: 0, maxBytes, source: undefined }
    try {
      const computer = await this.host.computer(run.computer.hostRef)
      return { ...await readHostCiLog(this.host.endpoint, computer, ciExecutionRunId(run), { ...input, maxBytes }),
        source: undefined }
    } catch (error) {
      if (!savedTail || !['passed', 'failed', 'canceled', 'lost'].includes(run.state)) throw error
      logIgnoredError('jobs', 'read CI executor log; returning saved tail', error, { ticketId: run.id })
      const bytes = Buffer.from('Previously collected output saved on Main; executor log unavailable.\n'
        + sanitizeCiText(savedTail), 'utf8')
      const afterOffset = input.afterOffset ?? Math.max(0, bytes.length - maxBytes)
      return { ...ciLogPage(bytes, afterOffset, maxBytes), logBytes: bytes.length, maxBytes,
        source: 'saved-tail' as const }
    }
  }
}
