import type pg from 'pg'
import type { CiHostStatus } from '@foreman-code/contracts'
import { CiRunRecordSchema, requiresUserSystemd, userSystemdIntegrationFiles,
  type CiRunRecord } from '@foreman-code/contracts'
import type { HostCiComputer, HostCiEndpoint } from './service.js'
import { isGitHubComputer, supportsUserSystemd } from './computerCapabilities.js'
import { fallbackOnError } from '../diagnostics/ignoredError.js'
import { executorSpeedKey, readExecutorSpeeds } from './executorSpeed.js'
import { buildComputerIntegrationShards } from './capacity.js'

/** How long weighting waits for a computer's live status it does not hold yet. */
const LIVE_STATUS_MS = 1000

/** Statuses planning already holds; reading them never waits on a Worker. */
interface PlanningStatuses {
  dispatchStatus?(computer: HostCiComputer): CiHostStatus | undefined
  lastStatus?(computer: HostCiComputer): CiHostStatus | undefined
}

/** Sizes a partitioned run's slices by the measured speed of the computers that will run them, so they finish
 * together: each free computer takes one slice, weighted by its throughput; slices without a computer yet get the
 * mean. Throughput is summed file time per wall time from recent completed gate parts. */
export async function weighCiPartitions(pool: pg.Pool,
  endpoint: HostCiEndpoint & PlanningStatuses,
  queued: CiRunRecord[], free: HostCiComputer[],
  read: (id: string, workspaceId: string) => Promise<CiRunRecord>): Promise<CiRunRecord[]> {
  const groupIds = [...new Set(queued.filter(run => run.suite === 'integration'
    && run.partition && !run.partition.weights).map(run => run.groupId))]
  if (!groupIds.length || !free.length) return queued
  const members = (await pool.query<{ record: unknown }>(
    'select record from ci_runs where group_id=any($1::uuid[])', [groupIds])).rows
    .map(row => CiRunRecordSchema.parse(row.record))
  const groups = new Map<string, CiRunRecord[]>()
  for (const run of members) {
    if (run.suite === 'integration' && run.partition) groups.set(run.groupId, [...groups.get(run.groupId) ?? [], run])
  }
  if (!groups.size) return queued
  const computers = [...new Map(free.map(computer => [computer.key, computer])).values()]
  const speed = await throughput(pool, endpoint, computers)
  const replaced = new Map<string, CiRunRecord>()
  for (const group of groups.values()) {
    group.sort((left, right) => left.partition!.index - right.partition!.index)
    const count = group[0]!.partition!.count
    if (group.length !== count) continue
    if (group.every(run => run.partition!.weights)) {
      for (const run of group) replaced.set(run.id, await read(run.id, run.workspaceId))
      continue
    }
    const existing = group.find(run => run.partition!.weights)
    const ordered = [...computers].sort((left, right) =>
      Number(isGitHubComputer(left)) - Number(isGitHubComputer(right))
      || right.priority - left.priority
      || (speed.get(right.key) ?? 0) - (speed.get(left.key) ?? 0))
    const systemdComputers = ordered.filter(supportsUserSystemd).sort((left, right) =>
      Number(right.hostRef.kind === 'cloud') - Number(left.hostRef.kind === 'cloud'))
    const selection = group[0]!
    const knownFiles = selection.scope === 'affected' && !selection.deriveFiles
    const hostFiles = knownFiles ? selection.files.filter(requiresUserSystemd).length : userSystemdIntegrationFiles.size
    const ordinaryFiles = knownFiles ? selection.files.length - hostFiles : count
    const hostCount = hostFiles ? Math.min(hostFiles, ordinaryFiles ? count - 1 : count,
      Math.max(1, systemdComputers.length, count - ordinaryFiles)) : 0
    const hostIndexes = existing ? existing.partition!.hostIndexes ?? []
      : Array.from({ length: hostCount }, (_, index) => index)
    // Keep systemd files separate so executors without a user manager can take ordinary slices.
    const planned: (HostCiComputer | undefined)[] = [
      ...hostIndexes.map(index => systemdComputers[index]),
      ...ordered.filter(computer => computer.hostRef.kind === 'cloud'
        && !systemdComputers.slice(0, hostCount).includes(computer)),
      ...systemdComputers.slice(hostCount).filter(computer => computer.hostRef.kind !== 'cloud'),
    ]
    const known = ordered.map(computer => speed.get(computer.key)).filter((value): value is number => value !== undefined)
    const mean = known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : 1
    const weights = existing?.partition!.weights ?? group.map((_, index) => {
      const computer = planned[index]
      return Number((computer ? speed.get(computer.key) ?? mean : mean).toPrecision(6))
    })
    const plan = group.map((run, index) => ({ id: run.id, patch: { partition: { ...run.partition!, weights,
        ...(hostIndexes.length ? { hostIndexes } : {}) },
      plannedHostKey: planned[index]?.key ?? null } }))
    // One immutable plan includes canceled siblings; their slices remain reserved and their state stays terminal.
    const saved = await pool.query<{ record: unknown }>(`update ci_runs
      set record=ci_runs.record || plan.patch
      from jsonb_to_recordset($1::jsonb) as plan(id text, patch jsonb)
      where ci_runs.id=plan.id::uuid and ci_runs.group_id=$2
        and ci_runs.record#>'{partition,weights}' is null
      returning ci_runs.record`, [JSON.stringify(plan), group[0]!.groupId])
    for (const row of saved.rows) {
      const run = CiRunRecordSchema.parse(row.record)
      replaced.set(run.id, run)
    }
    // A concurrent planner or assignment can exclude rows from the update; use their persisted state.
    for (const run of group) {
      if (!replaced.has(run.id)) replaced.set(run.id, await read(run.id, run.workspaceId))
    }
  }
  return queued.map(run => replaced.get(run.id) ?? run).filter(run => run.state === 'queued' && !run.computer)
}

/** A computer's live status, waited for at most LIVE_STATUS_MS; a slower read keeps refreshing for the next pass. */
async function liveStatus(endpoint: HostCiEndpoint, computer: HostCiComputer): Promise<CiHostStatus | undefined> {
  let timer: NodeJS.Timeout | undefined
  const reply = await Promise.race([
    endpoint.request(computer, { operation: 'status' })
      .catch(fallbackOnError(null, 'jobs', 'read CI computer status', { computer: computer.key })),
    new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), LIVE_STATUS_MS) }),
  ]).finally(() => clearTimeout(timer))
  return reply?.operation === 'status' ? reply : undefined
}

/** Weights from measured history and computer statuses: the ones dispatch already holds, otherwise a live read
 * bounded per computer. A computer without either gets the mean of the others. */
async function throughput(pool: pg.Pool, endpoint: HostCiEndpoint & PlanningStatuses,
  computers: HostCiComputer[]): Promise<Map<string, number>> {
  const measurements = await readExecutorSpeeds(pool, endpoint)
  const speed = new Map<string, number>()
  for (const computer of computers) {
    const measured = measurements.get(executorSpeedKey(computer))
    if (measured && typeof measured !== 'number') speed.set(computer.key, measured.conservativeThroughput)
  }
  if (speed.size === computers.length) return speed
  const statuses = await Promise.all(computers.map(async computer => ({ computer,
    status: endpoint.dispatchStatus?.(computer) ?? endpoint.lastStatus?.(computer) ?? await liveStatus(endpoint, computer) })))
  let measuredWork = 0
  let measuredShards = 0
  for (const { computer, status } of statuses) {
    if (!status || !speed.has(computer.key)) continue
    measuredWork += speed.get(computer.key)!
    measuredShards += buildComputerIntegrationShards(status, computer.buildAllowancePercent)
  }
  const perShard = measuredShards ? measuredWork / measuredShards : 1
  for (const { computer, status } of statuses) {
    if (speed.has(computer.key) || !status) continue
    speed.set(computer.key, perShard * buildComputerIntegrationShards(status, computer.buildAllowancePercent))
  }
  return speed
}
