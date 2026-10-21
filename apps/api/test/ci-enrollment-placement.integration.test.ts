import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/client'
import { CiEnrollmentStateSchema } from '@foreman-code/contracts'
import { JobDefinitionSpecRecordSchema, ResolvedVerificationJobSpecSchema, jobPolicyRequirementsRecord } from '@foreman-code/contracts/job-verification'
import { JobVerificationProfileSchema, jobRuntimeProfilePolicy } from '@foreman-code/contracts/job-verification-runtime'
import { describe, expect, it, vi } from 'vitest'
import { JobComputerSelection, type JobComputerCandidate } from '../src/modules/jobs/computerSelection.js'
import { JobService } from '../src/modules/jobs/service.js'
import { buildComputerKey } from '../src/modules/settings/buildComputers.js'
import { WorkerExecutionPolicy } from '../src/modules/settings/workerExecution.js'
import { buildComputerFixture, buildQueueFixture } from './helpers/buildComputerFixture.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { verificationCapacityFixture } from './helpers/verificationCapacityFixture.js'
import { verificationFixture } from './helpers/jobVerificationFixture.js'
import { ciEnrollmentFixture } from './ci-enrollment.test-support.js'

describe.skipIf(!postgresEnabled)('automatic CI enrollment: placement', () => {
  const fixture = ciEnrollmentFixture()

  it('places the same saved Auto verification request on an enrolled backup after its first computer disconnects', async () => {
    const f = await fixture()
    const sql = await f.db.pool.connect()
    try {
      const storage = f.inventory.storage
      f.inventory.storage = async target => {
        const capacity = await storage(target)
        if (capacity && buildComputerKey(target) === buildComputerKey(f.computers[1]!.target)) {
          return { diskBytes: capacity.diskBytes * 2, mutableInodes: capacity.mutableInodes * 2 }
        }
        return capacity
      }
      await f.enrollment.reconcile()
      const state = await f.enrollment.read(f.owner.principal, { workspaceId: f.workspaceId })
      const saved = (await f.profiles.list(f.owner.principal, f.workspaceId)).profiles
      const base = verificationFixture().spec
      const measured = verificationCapacityFixture('device').measurement!
      // Qualification and native metadata are boundary fixtures; save, envelope matching and claim persistence are real.
      const candidates: JobComputerCandidate[] = state.computers.slice(0, 2).map(computer => {
        const profile = saved.find(row => row.profile.id === computer.profileIds[0])!.profile
        if (profile.schemaVersion !== 2) throw new Error('Verification profile required')
        const root = profile.root
        const spec = ResolvedVerificationJobSpecSchema.parse({
          ...base, source: { ...root.source, commit: profile.sourceCommit! },
          policy: jobRuntimeProfilePolicy(profile), verification: { ...base.verification, resources: profile.spec.resources },
          target: { ...base.target, mainId: root.binding.mainId, mainInstallationId: root.binding.mainId,
            hostRef: root.selection.hostRef, registration: root.registration,
            destination: { ...base.target.destination, rootPolicyId: root.selection.rootPolicyId,
              canonicalProjectRoot: root.binding.canonicalPath, canonicalCwd: root.binding.canonicalPath,
              attestationId: root.attestationId, attestationHash: root.attestationDigest } } })
        const qualified = JobVerificationProfileSchema.parse({ ...profile, status: 'qualified',
          measurement: { ...measured,
            identity: { ...measured.identity, profileId: profile.id, profileRevision: profile.revision,
              rootId: root.binding.rootId, bindingRevision: root.binding.bindingRevision },
            fingerprint: { ...measured.fingerprint, profileId: profile.id, profileRevision: profile.revision,
              specDigest: profile.specDigest, root, hostRef: root.selection.hostRef, registration: root.registration,
              mainInstallationId: root.binding.mainId, approvalConfig: profile.approvalConfig },
          } })
        return { spec, profile: qualified, ready: true, reasons: [],
          sourceReservation: { scopeId: `${f.workspaceId}:${root.binding.rootId}`, reservedBytes: 1024 } }
      })
      const placement = new JobComputerSelection(f.settings, {
        candidates: async () => ({ candidates: candidates.filter(candidate =>
          f.computers.some(computer => computer.connected
            && buildComputerKey(computer.target) === buildComputerKey({ hostRef: candidate.spec.target.hostRef }))),
        diagnosticCodes: [] }),
      }, new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' }), async () => 64 * 2 ** 30)
      const unavailable = async (): Promise<never> => { throw new Error('This placement test does not launch a runtime') }
      const jobs = new JobService(f.db.pool, f.commands, { placement,
        preparation: { validate: (client, principal, workspaceId, spec) =>
          placement.validateRequest(client, principal, workspaceId, spec),
        choices: async () => ({ targets: [], sources: [], policies: [] }), accept: unavailable,
        revalidateAccepted: unavailable, adoptFinalBinding: unavailable },
        dispatch: { accept: unavailable, cancel: unavailable, cancelForRunCleanup: unavailable, wake: unavailable },
        artifacts: { list: async () => [], read: unavailable } })
      const first = candidates[0]!
      const definition = await jobs.saveDefinition(f.owner.principal, 'mcp', f.workspaceId, {
        commandId: randomUUID(), expectedRevision: null, name: 'Auto verification failover',
        spec: JobDefinitionSpecRecordSchema.parse({ ...first.spec, target: { kind: 'auto' },
          policy: jobPolicyRequirementsRecord(first.spec.policy),
          limits: first.profile.schemaVersion === 2 ? first.profile.spec.resources.limits : first.profile.limits }),
      })
      f.computers[0]!.connected = false
      const persisted = await jobs.getDefinition(f.owner.principal, f.workspaceId, definition.id)
      expect(persisted).toEqual(definition)
      await sql.query('begin')
      const identity = { executionId: randomUUID(), attemptId: randomUUID(), operationId: randomUUID() }
      const claim = await placement.claim(sql, f.owner.principal, persisted, identity)
      expect(claim.spec).toEqual(candidates[1]!.spec)
      expect(claim.compatibleTargetCount).toBe(1)
      await sql.query('commit')
      expect((await f.db.pool.query('select spec,limits from job_computer_selections where execution_id=$1',
        [identity.executionId])).rows[0]).toEqual({ spec: candidates[1]!.spec,
        limits: first.profile.schemaVersion === 2 ? first.profile.spec.resources.limits : first.profile.limits })
      expect(await jobs.getDefinitionVersion(f.owner.principal, f.workspaceId, definition.id, definition.versionId))
        .toEqual(definition)
    } finally {
      await sql.query('rollback')
      sql.release()
      await f.close()
    }
  })

  it('excludes a disabled enrollment from new Auto placement and re-enables it without changing its root', async () => {
    const f = await fixture()
    try {
      const target = f.computers[0]!.target
      if (target.hostRef.kind !== 'device') throw new Error('Worker fixture required')
      const computer = buildComputerFixture(target.hostRef.mainId, f.workspaceId, target.hostRef.deviceId)
      computer.candidate.spec.target.registration = f.roots[0]!.registration
      const placement = new JobComputerSelection(f.settings, {
        candidates: async () => ({ candidates: [computer.candidate], diagnosticCodes: [] }),
      }, new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' }))
      const validate = () => placement.validateRequest(f.db.pool, f.owner.principal, f.workspaceId, computer.auto)
      expect((await validate()).valid).toBe(true)
      await f.enrollment.update(f.owner.principal, 'mcp', { workspaceId: f.workspaceId, target,
        commandId: randomUUID(), expectedRevision: 0, enabled: false })
      expect(await validate()).toMatchObject({ valid: false, reasons: ['disabled'] })
      await f.enrollment.update(f.owner.principal, 'mcp', { workspaceId: f.workspaceId, target,
        commandId: randomUUID(), expectedRevision: 1, enabled: true })
      expect((await validate()).valid).toBe(true)
    } finally { await f.close() }
  })

  it.each([false, true])('serializes MCP disable with a queued claim with persisted enrollment=%s', async persisted => {
    const f = await fixture()
    let queue: Awaited<ReturnType<typeof buildQueueFixture>> | undefined
    let resume: (() => void) | undefined
    let claiming: Promise<void> | undefined
    let disabling: ReturnType<Client['callTool']> | undefined
    try {
      await f.enrollment.close()
      queue = await buildQueueFixture(f.db.pool, f.owner.principal, { workspaceId: f.workspaceId })
      const computer = queue.computers[0]!
      f.computers.push({ target: computer.target, connected: true, buildEnabled: true })
      const client = await f.connect()
      if (persisted) {
        const enabled = await client.callTool({ name: 'ci_enrollment_update', arguments: {
          workspaceId: f.workspaceId, target: computer.target, expectedRevision: 0,
          commandId: randomUUID(), enabled: true,
        } })
        expect(enabled.isError, JSON.stringify(enabled.content)).not.toBe(true)
      } else {
        expect((await f.db.pool.query('select 1 from ci_enrollment_computers where workspace_id=$1 and host_key=$2',
          [f.workspaceId, buildComputerKey(computer.target)])).rowCount).toBe(0)
      }
      const definition = await queue.save()
      const started = await queue.jobs.enqueue(f.owner.principal, 'mcp', f.workspaceId, {
        commandId: randomUUID(), definitionId: definition.id, expectedRevision: definition.revision,
      })
      if (started.kind !== 'pending-admission') throw new Error('Offline computer must keep the Job queued')
      await queue.jobs.wakeQueue()
      let reached!: () => void
      const entered = new Promise<void>(resolve => { reached = resolve })
      const paused = new Promise<void>(resolve => { resume = resolve })
      const requireEnabled = queue.settings.requireEnabled.bind(queue.settings)
      vi.spyOn(queue.settings, 'requireEnabled').mockImplementationOnce(async (...args) => {
        reached()
        await paused
        return requireEnabled(...args)
      })
      queue.online()
      claiming = queue.jobs.wakeQueue()
      await Promise.race([entered, claiming.then(() => { throw new Error('Claim did not reach the placement barrier') })])
      let disableReturned = false
      disabling = client.callTool({ name: 'ci_enrollment_update', arguments: {
        workspaceId: f.workspaceId, target: computer.target, expectedRevision: persisted ? 1 : 0,
        commandId: randomUUID(), enabled: false,
      } }).then(async result => {
        disableReturned = true
        expect((await f.db.pool.query('select 1 from job_computer_selections where execution_id=$1',
          [started.ticket.executionId])).rowCount).toBe(1)
        return result
      })
      await vi.waitFor(async () => {
        const waiting = (await f.db.pool.query<{ count: number }>(`select count(*)::int as count from pg_locks
          where locktype='advisory' and not granted
          and database=(select oid from pg_database where datname=current_database())
          and objid=(hashtext($1)::bigint & 4294967295)`,
        [`ci-enrollment:${f.workspaceId}:${buildComputerKey(computer.target)}`])).rows[0]!
        expect(waiting.count).toBe(1)
      }, { timeout: 2000 })
      expect(disableReturned).toBe(false)
      resume!()
      const disabled = await disabling
      expect(disabled.isError, JSON.stringify(disabled.content)).not.toBe(true)
      await claiming
      expect(await queue.jobs.getQueueTicket(f.owner.principal, f.workspaceId, started.ticket.id))
        .toMatchObject({ state: 'accepted', executionId: started.ticket.executionId })
      const readback = await client.callTool({ name: 'ci_enrollment_get', arguments: { workspaceId: f.workspaceId } })
      expect(CiEnrollmentStateSchema.parse(decodeMcpToolResult(readback)).computers
        .find(value => buildComputerKey(value.target) === buildComputerKey(computer.target)))
        .toMatchObject({ enabled: false, revision: persisted ? 2 : 1, state: 'disabled' })
      const next = await queue.jobs.enqueue(f.owner.principal, 'mcp', f.workspaceId, {
        commandId: randomUUID(), definitionId: definition.id, expectedRevision: definition.revision,
      })
      if (next.kind !== 'pending-admission') throw new Error('Disabled computer must keep the new Job queued')
      await queue.jobs.wakeQueue()
      expect(await queue.jobs.getQueueTicket(f.owner.principal, f.workspaceId, next.ticket.id))
        .toMatchObject({ state: 'blocked', waitingReasons: ['disabled'] })
      expect((await f.db.pool.query('select 1 from job_computer_selections where execution_id=$1',
        [next.ticket.executionId])).rowCount).toBe(0)
      expect((await f.db.pool.query('select spec from job_computer_selections where execution_id=$1',
        [started.ticket.executionId])).rows[0]!.spec).toMatchObject({ target: computer.candidate.spec.target })
    } finally {
      resume?.()
      await Promise.allSettled([claiming, disabling])
      await queue?.jobs.closeQueue()
      await f.close()
    }
  }, 30_000)
})
