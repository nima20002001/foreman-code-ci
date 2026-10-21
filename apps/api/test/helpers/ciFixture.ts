import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'
import { JobQueueTicketSchema } from '@foreman-code/contracts/job-admission'
import { JobDefinitionRecordSchema, jobPolicyRequirementsRecord, jobVerificationTemplate,
  JobVerificationReportSchema, VerificationJobExecutionSchema } from '@foreman-code/contracts/job-verification'
import { ManagementActionSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import type { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import type { PostgresSourceService } from '../../src/modules/sources/service.js'
import { JobService } from '../../src/modules/jobs/service.js'
import type { CiAuthority } from '../../src/modules/jobs/ciAuthority.js'
import { requireAuthorization } from '../../src/modules/access/policy.js'
import { DomainError } from '../../src/modules/errors.js'
import { DeviceAccessError } from '../../src/modules/devices/access.js'
import { DeviceApplicationError } from '../../src/modules/devices/deviceApplicationError.js'
import { jobDigest } from '../../src/modules/jobs/digest.js'
import { createSourceManifest } from '../../src/modules/sources/manifest.js'
import { jobExecution } from './jobFixture.js'
import { verificationRuntimeFixture } from './verificationRuntimeFixture.js'
import type { OperatorServices } from '../../src/mcp/operator/types.js'

/** Retained domain data for transport tests. No PostgreSQL or physical host is used. */
export function ciFixture(options: { initialWaitingReasons?: ('busy' | 'dependencies_changed')[] } = {}) {
  const workspaceId = 'workspace-fixture'
  const operator: ManagementPrincipal = { id: 'ci-operator', name: 'CI operator', audience: 'operator',
    expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
    grants: [{ actions: [...ManagementActionSchema.options], scope: { workspaceIds: [workspaceId] } }] }
  const worker: ManagementPrincipal = { ...operator, id: 'ci-agent', audience: 'worker', agentId: 'agent',
    grants: [{ actions: ['interactions:read'], scope: {
      workspaceIds: [workspaceId], workflowIds: ['workflow'], runIds: ['run'],
    } }] }
  const accepted = { ...operator, id: 'accepted-run-principal' }
  const readonly = { ...operator, id: 'readonly-operator', grants: [{ actions: ['jobs:read' as const],
    scope: { workspaceIds: [workspaceId] } }] }
  const receipts = new Map<string, { digest: string; target: string; result: unknown }>()
  const audits: Array<{ principalId: string; action: string; outcome: string }> = []
  const commands = {
    execute: async (input: { principal: ManagementPrincipal; operation: string; commandId: string;
      targetKey: string; payload: unknown; authorize?(sql: unknown): Promise<void>;
      prepare?(): Promise<void>; perform(sql: unknown): Promise<unknown> }) => {
      const sql = { query: async () => ({ rows: [] }) }
      await input.authorize?.(sql)
      const key = `${input.principal.id}:${input.operation}:${input.commandId}`
      const digest = jobDigest(input.payload)
      const existing = receipts.get(key)
      if (existing) {
        if (digest !== existing.digest || input.targetKey !== existing.target) {
          throw new DomainError('COMMAND_ID_CONFLICT', 'Command input changed.', 409)
        }
        return { value: structuredClone(existing.result), replayed: true }
      }
      if (input.prepare) {
        await input.prepare()
        await input.authorize?.(sql)
      }
      const value = await input.perform(sql)
      receipts.set(key, { digest, target: input.targetKey, result: JSON.parse(JSON.stringify(value)) })
      audits.push({ principalId: input.principal.id, action: input.operation, outcome: 'succeeded' })
      return { value, replayed: false }
    },
    recordDenied: async (principalId: string, _source: string, action: string) => {
      audits.push({ principalId, action, outcome: 'denied' })
    },
    recordAudit: async (principalId: string, _source: string, action: string, _target: string, outcome: string) => {
      audits.push({ principalId, action, outcome })
    },
  } as unknown as PostgresCommandCoordinator
  let head = 'b'.repeat(40)
  let sourceCaptures = 0
  let enqueues = 0
  let definition: ReturnType<typeof JobDefinitionRecordSchema.parse> | undefined
  let ticket: ReturnType<typeof JobQueueTicketSchema.parse> | undefined
  const definitions = new Map<string, ReturnType<typeof JobDefinitionRecordSchema.parse>>()
  const tickets = new Map<string, ReturnType<typeof JobQueueTicketSchema.parse>>()
  let execution: ReturnType<typeof VerificationJobExecutionSchema.parse> | undefined
  let summary: ReturnType<typeof JobVerificationReportSchema.parse> | undefined
  const runtime = verificationRuntimeFixture()
  const templates = [jobVerificationTemplate({ profileId: 'profile', profileRevision: 1,
    suite: 'unit', ready: true, resources: runtime.spec.verification.resources, maxUnitWorkers: 1,
    policy: jobPolicyRequirementsRecord(runtime.spec.policy) })]
  const roots: { offline: boolean; refusing?: boolean; source: unknown; selection: { rootPolicyId: string }
    binding: { rootId: string; bindingRevision: number; accessMode: 'exclusive-write' } }[] = [
    { offline: false, source: null, selection: { rootPolicyId: 'online-root' },
      binding: { rootId: randomUUID(), bindingRevision: 1, accessMode: 'exclusive-write' } },
    { offline: true, source: null, selection: { rootPolicyId: 'offline-root' },
      binding: { rootId: randomUUID(), bindingRevision: 1, accessMode: 'exclusive-write' } },
  ]
  const approvals: unknown[] = [], enqueued: unknown[] = []
  const agentExecution: { id?: string } = {}
  const authority: CiAuthority = { resolve: async (caller, requested, actions) => {
    if (caller.audience === 'worker' && caller.id !== worker.id) {
      throw new DomainError('ACCESS_DENIED', 'Unknown Run workspace.', 403)
    }
    const resolved = caller.audience === 'worker' ? workspaceId : requested
    if (!resolved || caller.audience === 'worker' && requested && requested !== workspaceId) {
      throw new DomainError('ACCESS_DENIED', 'Foreign workspace.', 403)
    }
    const principal = caller.audience === 'worker' ? accepted : caller
    for (const action of actions) requireAuthorization(principal, action, { workspaceId: resolved })
    return { principal, workspaceId: resolved, ...(caller.audience === 'worker' && agentExecution.id ? { executionId: agentExecution.id, initiatingAgent: { workflowId: 'workflow', runId: 'run',
      agentId: worker.agentId!, executionId: agentExecution.id } } : {}) }
  } }
  const sources = {
    approveProject: async (principal: ManagementPrincipal, input: { workspaceId: string; commandId: string; commit?: string
      snapshot?: { commit: string } }) => (approvals.push(input), await commands.execute({ principal, source: 'mcp', operation: 'source.project.capture',
        commandId: input.commandId, targetKey: workspaceId, payload: input, perform: async () => {
          sourceCaptures++
          const manifest = createSourceManifest({ version: 1, approvedSourceId: randomUUID(), snapshotId: randomUUID(),
            capturePolicy: 'git-tree-v1', executablePolicy: 'preserve-approved', deletions: [],
            git: { commit: input.snapshot?.commit ?? input.commit ?? head, tree: 'c'.repeat(40), objectFormat: 'sha1' },
            entries: ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].sort().map(path => ({
              path, sha256: 'a'.repeat(64), kind: 'file', executable: false, byteSize: 1,
            })) })
          return { manifest, workspaceId }
        } })).value,
    rootList: async () => ({ items: roots.map(root => structuredClone(root)) }),
    bindRoot: async (_principal: ManagementPrincipal, _source: string, input: {
      source: unknown; selection: { rootPolicyId: string }; expectedBindingRevision: number
    }) => {
      const root = roots.find(value => value.selection.rootPolicyId === input.selection.rootPolicyId)!
      if (root.offline) throw new DeviceAccessError('revoked')
      // The computer is connected but rejects the bind, as an out-of-scope root does.
      if (root.refusing) throw new DeviceApplicationError('extension-rejected')
      if (root.binding.bindingRevision !== input.expectedBindingRevision) {
        throw new DomainError('SOURCE_ROOT_REVISION_CONFLICT', 'Root binding changed.', 409)
      }
      root.source = input.source
      root.binding.bindingRevision++
      return { value: structuredClone(root), replayed: false }
    },
  } as unknown as PostgresSourceService
  const scopeCheck = (principal: ManagementPrincipal, scope: string) =>
    requireAuthorization(principal, 'jobs:read', { workspaceId: scope })
  const jobs = {
    choices: async () => ({ sources: [], targets: [], policies: [], verificationTemplates: structuredClone(templates) }),
    listDefinitions: async () => [...definitions.values()].map(value => structuredClone(value)),
    saveDefinition: async (_principal: ManagementPrincipal, _source: string, scope: string,
      input: { name: string; spec: unknown }) => {
      const now = new Date().toISOString()
      const prior = definitions.get(input.name)
      definition = JobDefinitionRecordSchema.parse({ schemaVersion: 2, id: prior?.id ?? randomUUID(),
        workspaceId: scope, revision: (prior?.revision ?? 0) + 1, versionId: randomUUID(),
        name: input.name, spec: input.spec, createdAt: now, updatedAt: now })
      definitions.set(input.name, definition)
      return structuredClone(definition)
    },
    enqueue: async (principal: ManagementPrincipal, _source: string, scope: string, input: {
      commandId: string; definitionId: string; placementOverride?: unknown
    }, enqueueOptions: { runtimePreparation?: ManagementPrincipal; initiatingAgent?: unknown } = {}) => {
      enqueues++
      enqueued.push(input)
      const queuedDefinition = [...definitions.values()].find(value => value.id === input.definitionId)
      if (!queuedDefinition) throw new Error('Missing saved definition')
      // One instant: the deadline is exactly the queue timeout after enqueue, even on a loaded machine.
      const at = Date.now(), now = new Date(at).toISOString()
      ticket = JobQueueTicketSchema.parse({ schemaVersion: 1, id: randomUUID(), workspaceId: scope, revision: 1,
        commandId: input.commandId, commandDigest: jobDigest(input), principalId: principal.id, definition: queuedDefinition,
        ...enqueueOptions,
        executionId: randomUUID(), attemptId: randomUUID(), operationId: randomUUID(), workflow: null, gateId: null,
        placement: input.placementOverride ?? ('kind' in queuedDefinition.spec.target
          ? { kind: 'auto' } : { kind: 'explicit', target: queuedDefinition.spec.target }),
        placementOverride: input.placementOverride ?? null,
        resources: 'verification' in queuedDefinition.spec ? queuedDefinition.spec.verification.resources : runtime.spec.verification.resources,
        enqueueSequence: '1', enqueuedAt: now,
        deadlineAt: new Date(at + queuedDefinition.spec.policy.queueTimeoutMs).toISOString(),
        state: 'waiting', waitingReasons: options.initialWaitingReasons ?? ['busy'], compatibleTargetCount: 1,
        queuePosition: 1, estimatedStartAt: null,
        reservationId: null, cancelRequestedAt: null, terminalReason: null, finishedAt: null })
      tickets.set(ticket.id, ticket)
      return { kind: 'pending-admission', ticket: structuredClone(ticket) }
    },
    getQueueTicket: async (principal: ManagementPrincipal, scope: string, id: string) => {
      scopeCheck(principal, scope)
      const retained = tickets.get(id)
      if (!retained || scope !== retained.workspaceId) {
        throw new DomainError('JOB_QUEUE_NOT_FOUND', 'Ticket not found in this workspace.', 404)
      }
      return structuredClone(retained)
    },
    cancelQueued: async (principal: ManagementPrincipal, _source: string, scope: string,
      input: { ticketId: string; expectedRevision: number; commandId: string }) => {
      const result = await commands.execute({ principal, source: 'mcp', operation: 'job.queue.cancel',
        commandId: input.commandId, targetKey: scope, payload: input,
        authorize: async () => { requireAuthorization(principal, 'jobs:cancel', { workspaceId: scope }) },
        perform: async () => {
          const current = tickets.get(input.ticketId)!
          if (current.revision !== input.expectedRevision) {
            throw new DomainError('JOB_QUEUE_REVISION_CONFLICT', 'Queue revision changed.', 409)
          }
          const stopped = JobQueueTicketSchema.parse({ ...current, revision: current.revision + 1,
            state: 'terminal', terminalReason: 'cancelled', cancelRequestedAt: current.enqueuedAt,
            finishedAt: current.enqueuedAt })
          tickets.set(input.ticketId, stopped)
          return stopped
        },
      })
      return result.value
    },
    getExecution: async () => structuredClone(execution),
    readLogTail: async () => ({ text: 'tests passed\n', truncated: false }),
    readLogs: async (_principal: ManagementPrincipal, _scope: string, id: string, after: number) => ({
      chunks: after === 0 ? [{ executionId: id, attemptId: execution!.attemptId, sequence: 1,
        stream: 'stdout', text: 'tests passed\n', byteSize: 13, createdAt: execution!.createdAt }] : [],
      nextCursor: Math.max(1, after), truncated: false, gap: null,
    }),
    listArtifacts: async () => [{ path: execution!.acceptedSpec.outputs[0]!.path, state: 'available',
      executionId: execution!.id, publicationId: 'publication', mediaType: 'application/json',
      sha256: createHash('sha256').update(JSON.stringify(summary)).digest('hex'),
      expiresAt: '2099-01-01T00:00:00.000Z',
      byteSize: Buffer.byteLength(JSON.stringify(summary)), fileId: 'summary-file', revisionId: 'summary-revision' }],
    readArtifactPage: JobService.prototype.readArtifactPage,
    readArtifact: async (principal: ManagementPrincipal, scope: string, id: string, fileId: string, revisionId: string) => {
      const artifact = (await jobs.listArtifacts(principal, scope, id, 'mcp'))[0]!
      if (artifact.fileId !== fileId || artifact.revisionId !== revisionId) {
        throw new DomainError('JOB_ARTIFACT_NOT_FOUND', 'Artifact revision unavailable.', 404)
      }
      return { artifact, bytes: Buffer.from(JSON.stringify(summary)) }
    },
  } as unknown as JobService
  const agent = { mainId: '11111111-1111-4111-8111-111111111111', deviceId: '22222222-2222-4222-8222-222222222222' }
  const pool = { connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
    query: async (text: string) => text.includes('execution_native_placements') ? { rows: [{ record: {
      materialization: { receipt: { binding: { mainId: agent.mainId, deviceId: agent.deviceId },
        worktree: { repository: 'octo/site', branch: 'foreman/review/coder-1', commit: 'b'.repeat(40) } } },
      workingTree: { canonicalProjectRoot: '/home/laptop/root/x/tree' } } }] } : { rows: [] } } as unknown as pg.Pool
  const services = { commands } as unknown as OperatorServices
  return { workspaceId, worker, operator, readonly, accepted, buildTarget: runtime.spec.target, services, audits, roots, approvals, enqueued, agent, agentExecution,
    templates, jobs, sources, commands, ticket: () => structuredClone(ticket!), definition: () => structuredClone(definition!),
    pool, authority,
    counts: () => ({ sourceCaptures, enqueues }), advanceHead: () => { head = 'd'.repeat(40) },
    complete: (options: { publication?: 'collecting' | 'failed' | 'expired'; failed?: true } = {}) => {
      if (!ticket || !('verification' in ticket.definition.spec)) throw new Error('Missing queued verification ticket')
      execution = VerificationJobExecutionSchema.parse({ ...jobExecution(), schemaVersion: 2,
        id: ticket.executionId, initiatingAgent: ticket.initiatingAgent, attemptId: ticket.attemptId, operationId: ticket.operationId, workspaceId,
        acceptedSpec: { ...runtime.spec, definitionVersionId: ticket.definition.versionId,
          verification: ticket.definition.spec.verification,
          source: { ...runtime.spec.source, ...ticket.definition.spec.source } },
        publication: options.publication ?? 'complete',
        finishedAt: new Date().toISOString(),
        resultIssue: options.publication === 'failed' ? 'publication_failed' : null,
        process: { phase: 'terminal', outcome: options.failed ? 'build_failed' : 'succeeded',
          exitCode: options.failed ? 1 : 0, signal: null, processStopped: true } })
      const publishing = options.publication === 'collecting'
      ticket = JobQueueTicketSchema.parse({ ...ticket, state: publishing ? 'accepted' : 'terminal',
        terminalReason: publishing ? null : 'completed', finishedAt: publishing ? null : execution.finishedAt,
        reservationId: ticket.id, queuePosition: null,
        waitingReasons: [], selectedComputer: { target: runtime.spec.target,
          rootId: runtime.spec.profile.rootId, bindingRevision: 1, profileId: 'profile', profileRevision: 1 } })
      tickets.set(ticket.id, ticket)
      const spec = execution!.acceptedSpec
      summary = JobVerificationReportSchema.parse({ schemaVersion: 1, commit: spec.source.commit,
        manifestDigest: spec.source.manifestDigest, definitionVersionId: spec.definitionVersionId,
        suite: spec.verification.suite, executionId: execution!.id, attemptId: execution!.attemptId, target: spec.target,
        profile: spec.profile, resources: spec.verification.resources, parameters: spec.verification.parameters,
        startedAt: ticket.enqueuedAt, finishedAt: new Date().toISOString(),
        totals: { total: 3, passed: options.failed ? 2 : 3, failed: options.failed ? 1 : 0, skipped: 0 },
        firstPassFailed: options.failed ? 1 : 0, expectedPortions: 1,
        completedPortions: 1, disallowedSkipped: 0, completeness: 'complete', outcome: options.failed ? 'failed' : 'passed' })
    },
  }
}
