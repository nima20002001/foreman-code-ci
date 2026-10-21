import { componentLogger } from '../diagnostics/logger.js'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { CiRunRecordSchema, integrationPartition, requiresUserSystemd,
  type CiDurations, type CiRunRecord } from '@foreman-code/contracts'
import { withTransaction } from '../../infrastructure/transaction.js'
import { supportsUserSystemd } from './computerCapabilities.js'
import type { HostCiComputer } from './serviceTypes.js'
import { serializeCiJson } from './text.js'
import { ciExecutionRunId } from './executionAttempt.js'

const BUILD_WAIT_MS = 90_000
const CLOUD_TEST_MS = 240_000

export function buildComputerGatePart(run: CiRunRecord, computers: readonly HostCiComputer[]) {
  return Boolean(run.gate && run.suite === 'integration' && run.plannedHostKey
    && !computers.some(computer => computer.key === run.plannedHostKey && computer.hostRef.kind === 'cloud'))
}

interface FallbackCapacity {
  computers: HostCiComputer[]
  /** Identifies the planned executor even when it is absent from the schedulable fleet. */
  knownComputers?: readonly HostCiComputer[]
  shards: Map<string, number>
  durations: Map<string, CiDurations | null>
  reservedCloud: Set<string>
  gate: CiRunRecord | undefined
  freeSlots(computer: HostCiComputer): number
  idle(computer: HostCiComputer): boolean
  canTake(run: CiRunRecord, computer: HostCiComputer): boolean
}

function cloudParts(run: CiRunRecord, capacity: FallbackCapacity) {
  const clouds = capacity.computers.filter(computer => computer.hostRef.kind === 'cloud'
    && capacity.shards.has(computer.key) && capacity.freeSlots(computer) > 0
    && !capacity.reservedCloud.has(computer.key)
    && !run.unstartedProviders?.includes(computer.hostRef.provider!))
  const durations = capacity.durations.get(run.id) ?? {}
  const files = [...new Set(run.files)]
  const known = files.map(file => durations[file]).filter((ms): ms is number => ms !== undefined)
    .sort((left, right) => left - right)
  const median = known[Math.floor(known.length / 2)] ?? 30_000
  const duration = (file: string) => durations[file] ?? median
  const result: CiRunRecord[] = []
  for (const systemd of [false, true]) {
    const selected = files.filter(file => requiresUserSystemd(file) === systemd)
    if (!selected.length) continue
    const eligible = clouds.filter(computer => !systemd || supportsUserSystemd(computer))
    if (!eligible.length) return []
    const total = selected.reduce((sum, file) => sum + duration(file), 0)
    const count = Math.min(selected.length, 64, Math.max(2, Math.ceil(total / CLOUD_TEST_MS)))
    for (let index = 0; index < count; index++) {
      const slice = integrationPartition(selected, durations, { index, count, targetDurationMs: CLOUD_TEST_MS })
      if (!slice.length) continue
      const computer = eligible[index % eligible.length]!
      const original = result.length === 0
      const id = original ? run.id : randomUUID()
      // The original ticket alone owns earlier attempts; each added ticket starts its own execution.
      result.push(CiRunRecordSchema.parse({ ...run, id,
        executionRunId: original ? ciExecutionRunId(run) : id,
        retainedExecutions: original ? run.retainedExecutions : undefined,
        executionHistory: original ? run.executionHistory : undefined,
        setupRetry: original ? run.setupRetry : undefined,
        files: slice, partition: null, plannedHostKey: computer.key,
        integrationShards: capacity.shards.get(computer.key), requiresBuildComputer: systemd,
        expectedDurationMs: BUILD_WAIT_MS + slice.reduce((sum, file) => sum + duration(file), 0),
        speedFactor: undefined, dispatchAttempts: undefined,
        reassignment: { count: (run.reassignment?.count ?? 0) + 1, previousHostKey: run.plannedHostKey!,
          lastError: 'CI_BUILD_COMPUTER_UNAVAILABLE', at: new Date().toISOString() },
        message: `Build computer ${run.plannedHostKey} unavailable after 90 seconds; reassigned to cloud.` }))
    }
  }
  return result
}

async function saveCloudParts(pool: pg.Pool, previous: CiRunRecord, parts: CiRunRecord[], durations: CiDurations | null) {
  return withTransaction(pool, async client => {
    // The original ticket stays readable; its compare-and-swap also prevents competing splits and assignments.
    const saved = await client.query(`update ci_runs set state=$2, host_key=$3, record=$4::jsonb
      where id=$1 and state='queued' and host_key is null and record=$5::jsonb`,
    [previous.id, 'queued', null, serializeCiJson(parts[0]!), JSON.stringify(previous)])
    if (!saved.rowCount) return false
    for (const part of parts.slice(1)) {
      await client.query(`insert into ci_runs(id,workspace_id,group_id,record,durations,state)
        values($1,$2,$3,$4::jsonb,$5::jsonb,'queued')`,
      [part.id, part.workspaceId, part.groupId, serializeCiJson(part), durations ? serializeCiJson(durations) : null])
    }
    return true
  })
}

/** Convert an unassigned build selection after its grace period; uncertain deliveries keep their ownership. */
export async function splitUnavailableGateParts(pool: pg.Pool, queued: CiRunRecord[], capacity: FallbackCapacity) {
  const result: CiRunRecord[] = []
  for (const run of queued) {
    const waiting = buildComputerGatePart(run, capacity.knownComputers ?? capacity.computers)
      && !run.partition && !run.dispatchHostKey && !run.dispatchRequest && !run.cancellation
      && (!capacity.gate || capacity.gate.groupId === run.groupId)
      && Date.now() - Date.parse(run.queuedAt) > BUILD_WAIT_MS
      && !capacity.shards.has(run.plannedHostKey!)
    const buildAvailable = waiting && capacity.computers.some(computer => computer.hostRef.kind !== 'cloud'
      && capacity.canTake(run, computer) && capacity.idle(computer) && capacity.freeSlots(computer) > 0
      && (!run.requiresBuildComputer || supportsUserSystemd(computer)))
    const parts = waiting && !buildAvailable ? cloudParts(run, capacity) : []
    if (!parts.length) {
      result.push(run)
      continue
    }
    const durations = capacity.durations.get(run.id) ?? null
    if (await saveCloudParts(pool, run, parts, durations)) {
      componentLogger('jobs').warn({ operation: 'reassign unavailable CI build part', runId: run.id,
        originalHostKey: run.plannedHostKey, replacementParts: parts.length }, 'Unavailable build part reassigned to cloud')
      for (const part of parts) capacity.durations.set(part.id, durations)
      result.push(...parts)
    }
  }
  return result
}
