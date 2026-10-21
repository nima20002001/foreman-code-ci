import { isDeepStrictEqual } from 'node:util'
import { withTransaction } from '../../infrastructure/transaction.js'
import type pg from 'pg'
import { z } from 'zod'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import {
  nextOccurrences, parseScheduleSaveInput, scheduleConfigurationToUtc, ScheduleDisableInputSchema, ScheduleDisableResultSchema,
  ScheduleGetInputSchema, ScheduleGetResultSchema, ScheduleSaveInputSchema, ScheduleSaveResultSchema,
  WorkflowScheduleSchema, type ScheduleConfiguration, type ScheduleGetInput, type ScheduleGetResult,
  type ScheduleSaveResult, type WorkflowSchedule,
} from '@foreman-code/contracts/schedules'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { requireAuthorization } from '../access/policy.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { captureScheduleAuthority } from './authority.js'
import { PostgresWorkflowScheduleRepository, type ScheduleSlot } from './postgres.js'
import {
  ScheduleClearInputSchema, ScheduleClearResultSchema, ScheduleEnableResultSchema,
  ScheduleOccurrenceListInputSchema, type ScheduleOccurrencePage,
} from './transportSchemas.js'

type Source = 'http' | 'mcp'
type Action = 'workflows:read' | 'workflows:update'

/** Public input errors must not become MCP INTERNAL_ERROR; stored-data errors stay private. */
function parseRequest<T>(work: () => T): T {
  try { return work() } catch (error) {
    if (error instanceof z.ZodError) {
      throw new DomainError('INVALID_REQUEST', 'The request does not match its schedule contract.', 400, {
        issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      }, { cause: error })
    }
    throw error
  }
}

/** Weekday ordering and instant offsets are not different command payloads. */
function normalizeConfiguration(value: ScheduleConfiguration): ScheduleConfiguration {
  return value.mode === 'weekly' ? { ...value, weekdays: [...value.weekdays].sort((left, right) => left - right) } : value
}
function configuration(value: WorkflowSchedule): ScheduleConfiguration {
  const settings = { timezone: value.timezone, enabled: value.enabled, policy: value.policy }
  switch (value.mode) {
    case 'weekly': return { ...settings, mode: value.mode, weekdays: value.weekdays, time: value.time }
    case 'interval': return { ...settings, mode: value.mode, every: value.every, unit: value.unit, anchorAt: value.anchorAt }
    case 'once': return { ...settings, mode: value.mode, localDate: value.localDate, time: value.time }
  }
}
function sameRecurrence(current: WorkflowSchedule, settings: ScheduleConfiguration): boolean {
  const saved = normalizeConfiguration(scheduleConfigurationToUtc(configuration(current)))
  if (saved.mode === 'interval' && settings.mode === 'interval') {
    // Interval timezone is display metadata; elapsed recurrence uses the UTC anchor.
    return saved.every === settings.every && saved.unit === settings.unit && saved.anchorAt === settings.anchorAt
  }
  return isDeepStrictEqual({ ...saved, enabled: settings.enabled }, settings)
}
function checkRevision(slot: ScheduleSlot | null, expected: number): void {
  const currentRevision = slot?.value?.revision ?? 0
  if (currentRevision !== expected) {
    throw new DomainError('REVISION_CONFLICT', 'The schedule changed since it was read.', 409, { currentRevision })
  }
}
function nextRevision(slot: ScheduleSlot | null): number {
  const revision = (slot?.lastRevision ?? 0) + 1
  if (!Number.isSafeInteger(revision)) throw new DomainError('REVISION_EXHAUSTED', 'The schedule revision limit was reached.', 409)
  return revision
}
function requiredValue(slot: ScheduleSlot | null): WorkflowSchedule {
  if (!slot?.value) throw new DomainError('SCHEDULE_NOT_FOUND', 'This workflow has no saved schedule.', 404)
  return slot.value
}

/** Schedule persistence only. No dispatcher, Run creation, timer or native harness dependency. */
export class WorkflowScheduleService {
  readonly repository: PostgresWorkflowScheduleRepository
  constructor(
    private readonly pool: pg.Pool,
    private readonly commands: PostgresCommandCoordinator,
    private readonly clock: () => Date = () => new Date(),
  ) { this.repository = new PostgresWorkflowScheduleRepository(pool) }

  private async authorize(client: pg.PoolClient, principal: ManagementPrincipal, scope: ScheduleGetInput, action: Action) {
    const live = await readLiveManagementPrincipal(client, principal.id)
    requireAuthorization(live, action, scope)
    await this.repository.requireWorkflow(client, scope)
  }

  private async read<T>(principal: ManagementPrincipal, scope: ScheduleGetInput,
    work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    requireAuthorization(principal, 'workflows:read', scope)
    return withTransaction(this.pool, async (client) => {
      await this.authorize(client, principal, scope, 'workflows:read')
      const result = await work(client)
      return result
    })
  }

  async get(principal: ManagementPrincipal, raw: unknown): Promise<ScheduleGetResult> {
    const input = parseRequest(() => ScheduleGetInputSchema.parse(raw))
    return this.read(principal, input, async (client) => ScheduleGetResultSchema.parse({
      schedule: (await this.repository.getSlot(client, input))?.value ?? null,
    }))
  }

  async save(principal: ManagementPrincipal, source: Source, raw: unknown): Promise<ScheduleSaveResult> {
    const parsed = parseRequest(() => ScheduleSaveInputSchema.parse(raw))
    const input = { ...parsed, schedule: normalizeConfiguration(parsed.schedule) }
    requireAuthorization(principal, 'workflows:update', input)
    return ScheduleSaveResultSchema.parse(await this.commands.execute({
      principal, source, operation: 'workflow.schedule.save', commandId: input.commandId,
      targetKey: JSON.stringify(['workflow-schedule', input.workspaceId, input.workflowId]), payload: input,
      replayResult: (value) => WorkflowScheduleSchema.parse(value),
      authorize: (client) => this.authorize(client, principal, input, 'workflows:update'),
      perform: async (client) => {
        const slot = await this.repository.lock(client, input)
        // A wait on the workflow can outlast credential expiry. Recheck before a new write.
        await this.authorize(client, principal, input, 'workflows:update')
        checkRevision(slot, input.expectedRevision)
        // After receipt lookup AND after waiting for the workflow lock. Never use the caller's clock.
        const now = this.clock().toISOString()
        const settings = parseRequest(() => scheduleConfigurationToUtc(input.schedule))
        const current = slot?.value
        const unchanged = current && sameRecurrence(current, settings)
        if (!unchanged) parseRequest(() => parseScheduleSaveInput(input, now))
        let nextOccurrenceAt: string | null
        if (current?.enabled && settings.enabled && unchanged) {
          nextOccurrenceAt = current.nextOccurrenceAt
        } else {
          nextOccurrenceAt = nextOccurrences(settings, now, 1)[0] ?? null
        }
        const value = WorkflowScheduleSchema.parse({ ...settings,
          workspaceId: input.workspaceId, workflowId: input.workflowId, revision: nextRevision(slot),
          nextOccurrenceAt,
        })
        await this.repository.put(client, value, principal.id)
        await captureScheduleAuthority(client, value, principal.id)
        return value
      },
    }))
  }

  async enable(principal: ManagementPrincipal, source: Source, raw: unknown) {
    return ScheduleEnableResultSchema.parse(await this.setEnabled(principal, source, raw, true))
  }

  async disable(principal: ManagementPrincipal, source: Source, raw: unknown) {
    return ScheduleDisableResultSchema.parse(await this.setEnabled(principal, source, raw, false))
  }

  private async setEnabled(principal: ManagementPrincipal, source: Source, raw: unknown, enabled: boolean) {
    const input = parseRequest(() => ScheduleDisableInputSchema.parse(raw))
    requireAuthorization(principal, 'workflows:update', input)
    return this.commands.execute({
      principal, source, operation: enabled ? 'workflow.schedule.enable' : 'workflow.schedule.disable', commandId: input.commandId,
      targetKey: JSON.stringify(['workflow-schedule', input.workspaceId, input.workflowId]), payload: input,
      replayResult: (value) => WorkflowScheduleSchema.parse(value),
      authorize: (client) => this.authorize(client, principal, input, 'workflows:update'),
      perform: async (client) => {
        const slot = await this.repository.lock(client, input)
        // A wait on the workflow can outlast credential expiry. Recheck before a new write.
        await this.authorize(client, principal, input, 'workflows:update')
        checkRevision(slot, input.expectedRevision)
        const current = requiredValue(slot)
        const now = this.clock().toISOString()
        let nextOccurrenceAt = current.nextOccurrenceAt
        if (!enabled) {
          nextOccurrenceAt = null
        } else if (!current.enabled) {
          const settings = { ...configuration(current), enabled }
          nextOccurrenceAt = nextOccurrences(settings, now, 1)[0] ?? null
        }
        const value = WorkflowScheduleSchema.parse({ ...current, enabled, revision: nextRevision(slot),
          nextOccurrenceAt,
        })
        await this.repository.put(client, value, principal.id)
        await captureScheduleAuthority(client, value, principal.id)
        return value
      },
    })
  }

  async clear(principal: ManagementPrincipal, source: Source, raw: unknown) {
    const input = parseRequest(() => ScheduleClearInputSchema.parse(raw))
    requireAuthorization(principal, 'workflows:update', input)
    return ScheduleClearResultSchema.parse(await this.commands.execute({
      principal, source, operation: 'workflow.schedule.clear', commandId: input.commandId,
      targetKey: JSON.stringify(['workflow-schedule', input.workspaceId, input.workflowId]), payload: input,
      replayResult: (value) => ScheduleClearResultSchema.shape.value.parse(value),
      authorize: (client) => this.authorize(client, principal, input, 'workflows:update'),
      perform: async (client) => {
        const slot = await this.repository.lock(client, input)
        // A wait on the workflow can outlast credential expiry. Recheck before a new write.
        await this.authorize(client, principal, input, 'workflows:update')
        checkRevision(slot, input.expectedRevision)
        requiredValue(slot)
        await this.repository.clear(client, input, nextRevision(slot), principal.id)
        return null
      },
    }))
  }

  async recentOccurrences(principal: ManagementPrincipal, raw: unknown): Promise<ScheduleOccurrencePage> {
    const input = parseRequest(() => ScheduleOccurrenceListInputSchema.parse(raw))
    return this.read(principal, input, (client) => this.repository.recent(client, input))
  }
}
