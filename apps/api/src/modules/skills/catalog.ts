import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { GraphSqlClient } from '../run-graph/connection.js'
import type { AssignedSkill, ResolvedSkill, WorkspaceSkillReference } from '@foreman-code/contracts'
import {
  SkillListInputSchema, SkillVersionSchema, SkillVersionSummarySchema,
  type ManagementPrincipal, type SkillArchiveInput, type SkillCreateInput, type SkillListInput, type SkillSummary,
  type SkillUpdateInput, type SkillVersion,
} from '@foreman-code/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { authorizedPage } from '../access/authorizedPage.js'
import { lockActiveWorkspace } from '../workspaces/admission.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'

type Source = 'http' | 'mcp'

export function skillHash(instructions: string): string {
  return `sha256:${createHash('sha256').update(instructions, 'utf8').digest('hex')}`
}

function verifiedVersion(record: unknown): SkillVersion {
  const skill = SkillVersionSchema.parse(record)
  if (skill.contentHash !== skillHash(skill.instructions)) {
    throw new DomainError('SKILL_INTEGRITY_FAILED', 'The saved skill version failed its integrity check.', 409)
  }
  return skill
}

/** Catalog contents, not mutable pointers, are copied into an immutable execution snapshot.
 * Archived skills cannot be newly assigned; a reference the Agent already pinned stays valid. */
export async function resolveAssignedSkills(client: GraphSqlClient, workspaceId: string, references: readonly AssignedSkill[],
  retained: readonly AssignedSkill[] = []): Promise<ResolvedSkill[]> {
  if (references.length > 100) throw new DomainError('SKILL_LIMIT_EXCEEDED', 'At most 100 skills can be assigned.', 400)
  const seen = new Set<string>()
  const resolved: ResolvedSkill[] = []
  for (const reference of references) {
    if (seen.has(reference.skillId)) throw new DomainError('SKILL_DUPLICATE', 'Assign only one version of each skill.', 400)
    seen.add(reference.skillId)
    // Share-lock the head so an archive cannot commit between this check and publication.
    const head = (await client.query<{ archived_at: Date | null }>(
      'select archived_at from workspace_skills where workspace_id=$1 and skill_id=$2 for share', [workspaceId, reference.skillId])).rows[0]
    const result = await client.query<{ record: unknown }>(
      'select record from workspace_skill_versions where workspace_id=$1 and skill_id=$2 and version=$3',
      [workspaceId, reference.skillId, reference.version],
    )
    if (!head || !result.rows[0]) throw new DomainError('SKILL_VERSION_NOT_FOUND', `Skill '${reference.skillId}@${reference.version}' is not in this workspace's skills.`, 409)
    if (head.archived_at && !retained.some((item) => item.skillId === reference.skillId && item.version === reference.version)) {
      throw new DomainError('SKILL_ARCHIVED', `Skill '${reference.skillId}' is archived. Restore it before assigning it.`, 409)
    }
    const skill = SkillVersionSchema.parse(result.rows[0].record)
    if (skill.workspaceId !== workspaceId || skill.skillId !== reference.skillId || skill.version !== reference.version
      || skill.contentHash !== skillHash(skill.instructions)) throw new DomainError('SKILL_INTEGRITY_FAILED', 'The saved skill version failed its identity/integrity check.', 409)
    resolved.push({ skillId: skill.skillId, version: skill.version, name: skill.name, instructions: skill.instructions, contentHash: skill.contentHash })
  }
  return resolved
}

/** For the application-level Operator, whose ordered references may span workspaces. */
export async function resolveWorkspaceSkills(client: pg.ClientBase, references: readonly WorkspaceSkillReference[],
  retained: readonly WorkspaceSkillReference[] = []): Promise<ResolvedSkill[]> {
  if (references.length > 100) throw new DomainError('SKILL_LIMIT_EXCEEDED', 'At most 100 skills can be assigned.', 400)
  if (new Set(references.map((item) => JSON.stringify([item.workspaceId, item.skillId]))).size !== references.length) throw new DomainError('SKILL_DUPLICATE', 'Assign only one version of each skill.', 400)
  const resolved: ResolvedSkill[] = []
  for (const reference of references) {
    const snapshots = await resolveAssignedSkills(client, reference.workspaceId, [{ skillId: reference.skillId, version: reference.version }],
      retained.filter((item) => item.workspaceId === reference.workspaceId))
    resolved.push(...snapshots.map((skill) => ({ ...skill, workspaceId: reference.workspaceId })))
  }
  return resolved
}

interface HeadRow {
  workspace_id: string; skill_id: string; head_version: string; revision: string; version_count: number
  archived_at: Date | null; created_at: Date; updated_at: Date; record: unknown
}
const HEAD_SELECT = `select s.workspace_id,s.skill_id,s.head_version,s.revision::text,s.version_count,s.archived_at,s.created_at,s.updated_at,v.record
  from workspace_skills s join workspace_skill_versions v on v.workspace_id=s.workspace_id and v.skill_id=s.skill_id and v.version=s.head_version`

function summary(row: HeadRow): SkillSummary {
  const version = SkillVersionSchema.parse(row.record)
  return {
    workspaceId: row.workspace_id, skillId: row.skill_id, name: version.name,
    ...(version.description ? { description: version.description } : {}),
    version: row.head_version, contentHash: version.contentHash, revision: Number(row.revision), versionCount: row.version_count,
    archived: row.archived_at !== null, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  }
}

function encodeCursor(value: unknown[]): string { return Buffer.from(JSON.stringify(value)).toString('base64url') }
function decodeCursor<T extends unknown[]>(cursor: string | undefined, valid: (value: unknown[]) => boolean): T | null {
  if (!cursor) return null
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (Array.isArray(value) && valid(value)) return value as T
  } catch { /* ignore: reported below */ }
  throw new DomainError('CURSOR_INVALID', 'The skill cursor is invalid.', 400)
}
const listCursor = (item: SkillSummary) => encodeCursor([item.name.toLowerCase(), item.workspaceId, item.skillId])

export class SkillCatalogService {
  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator) {}

  /** Logical skills, one row each, ordered by name. Without a workspace, only workspaces the caller may read. */
  async list(principal: ManagementPrincipal, raw: SkillListInput) {
    const input = SkillListInputSchema.parse(raw)
    if (input.workspaceId) requireAuthorization(principal, 'skills:read', { workspaceId: input.workspaceId })
    decodeCursor(input.cursor, (value) => value.length === 3 && value.every((entry) => typeof entry === 'string'))
    const search = input.query ? `%${input.query.replace(/[\\%_]/g, (match) => `\\${match}`)}%` : null
    return authorizedPage({
      principal, action: 'skills:read', cursor: input.cursor, limit: input.limit,
      read: async (cursor, limit) => {
        const after = decodeCursor<[string, string, string]>(cursor, (value) => value.length === 3)
        const rows = await this.pool.query<HeadRow>(`${HEAD_SELECT} join workspaces w on w.id=s.workspace_id
          where w.archived_at is null and ($1::text is null or s.workspace_id=$1) and ($2 or s.archived_at is null)
            and ($3::text is null or v.record->>'name' ilike $3 or coalesce(v.record->>'description','') ilike $3)
            and ($4::text is null or (lower(v.record->>'name'),s.workspace_id,s.skill_id) > ($4,$5,$6))
          order by lower(v.record->>'name'),s.workspace_id,s.skill_id limit $7`,
        [input.workspaceId ?? null, input.includeArchived, search, after?.[0] ?? null, after?.[1] ?? null, after?.[2] ?? null, limit])
        return rows.rows.map(summary)
      },
      id: listCursor, resource: (item) => ({ workspaceId: item.workspaceId }),
    })
  }

  async get(principal: ManagementPrincipal, input: { workspaceId: string; skillId: string; version?: string | undefined }) {
    requireAuthorization(principal, 'skills:read', { workspaceId: input.workspaceId })
    const head = await this.head(this.pool, input.workspaceId, input.skillId)
    const version = input.version ?? head.version
    const rows = await this.pool.query<{ record: unknown }>(
      'select record from workspace_skill_versions where workspace_id=$1 and skill_id=$2 and version=$3', [input.workspaceId, input.skillId, version])
    if (!rows.rows[0]) throw new DomainError('SKILL_VERSION_NOT_FOUND', 'The skill version was not found.', 404)
    return { skill: head, version: verifiedVersion(rows.rows[0].record) }
  }

  /** Newest first. Summaries omit instruction bodies; read one exact version with get. */
  async versions(principal: ManagementPrincipal, input: { workspaceId: string; skillId: string; limit: number; cursor?: string | undefined }) {
    requireAuthorization(principal, 'skills:read', { workspaceId: input.workspaceId })
    await this.head(this.pool, input.workspaceId, input.skillId)
    const before = decodeCursor<[number]>(input.cursor, (value) => value.length === 1 && Number.isSafeInteger(value[0]))
    const rows = await this.pool.query<{ record: unknown; sequence: number }>(
      `select record,sequence from workspace_skill_versions where workspace_id=$1 and skill_id=$2 and ($3::integer is null or sequence<$3)
       order by sequence desc limit $4`, [input.workspaceId, input.skillId, before?.[0] ?? null, input.limit + 1])
    const page = rows.rows.slice(0, input.limit)
    const items = page.map((row) => SkillVersionSummarySchema.parse(SkillVersionSchema.omit({ instructions: true }).strip().parse(row.record)))
    return { items, pageInfo: { nextCursor: rows.rows.length > input.limit ? encodeCursor([page.at(-1)!.sequence]) : null } }
  }

  async create(principal: ManagementPrincipal, input: SkillCreateInput, source: Source) {
    requireAuthorization(principal, 'skills:publish', { workspaceId: input.workspaceId })
    return this.commands.execute({ principal, source, operation: 'skill.create', commandId: input.commandId,
      targetKey: `workspace:${input.workspaceId}:skills`, payload: input,
      authorize: async (client) => { await this.authorizePublish(client, principal, input.workspaceId) },
      perform: async (client) => {
        const skillId = `skill-${randomUUID()}`
        const version = await this.insertVersion(client, input.workspaceId, skillId, 1, input)
        await client.query(`insert into workspace_skills(workspace_id,skill_id,head_version,revision,version_count) values($1,$2,$3,1,1)`,
          [input.workspaceId, skillId, version.version])
        return { skill: await this.head(client, input.workspaceId, skillId), version, changed: true }
      },
    })
  }

  /** Saves a new immutable version when content changed; an identical save creates nothing. */
  async update(principal: ManagementPrincipal, input: SkillUpdateInput, source: Source) {
    requireAuthorization(principal, 'skills:publish', { workspaceId: input.workspaceId })
    return this.commands.execute({ principal, source, operation: 'skill.update', commandId: input.commandId,
      targetKey: `workspace:${input.workspaceId}:skill:${input.skillId}`, payload: input,
      authorize: async (client) => { await this.authorizePublish(client, principal, input.workspaceId) },
      perform: async (client) => {
        const head = await this.lockedHead(client, input)
        if (head.archived) throw new DomainError('SKILL_ARCHIVED', 'Restore this archived skill before editing it.', 409)
        const current = verifiedVersion((await client.query<{ record: unknown }>(
          'select record from workspace_skill_versions where workspace_id=$1 and skill_id=$2 and version=$3',
          [input.workspaceId, input.skillId, head.version])).rows[0]?.record)
        if (current.name === input.name && (current.description ?? '') === (input.description ?? '') && current.instructions === input.instructions) {
          return { skill: head, version: current, changed: false }
        }
        const sequence = (await client.query<{ next: number }>(
          'select max(sequence)+1 as next from workspace_skill_versions where workspace_id=$1 and skill_id=$2',
          [input.workspaceId, input.skillId])).rows[0]!.next
        const version = await this.insertVersion(client, input.workspaceId, input.skillId, sequence, input)
        await client.query(`update workspace_skills set head_version=$3,revision=revision+1,version_count=version_count+1,updated_at=now()
          where workspace_id=$1 and skill_id=$2`, [input.workspaceId, input.skillId, version.version])
        return { skill: await this.head(client, input.workspaceId, input.skillId), version, changed: true }
      },
    })
  }

  /** Archive hides a skill from discovery and new assignment; versions and pinned snapshots remain. */
  async archive(principal: ManagementPrincipal, input: SkillArchiveInput, source: Source) {
    requireAuthorization(principal, 'skills:publish', { workspaceId: input.workspaceId })
    requireAuthorization(principal, 'skills:read', { workspaceId: input.workspaceId })
    return this.commands.execute({ principal, source, operation: 'skill.archive', commandId: input.commandId,
      targetKey: `workspace:${input.workspaceId}:skill:${input.skillId}`, payload: input,
      authorize: async (client) => {
        const live = await this.authorizePublish(client, principal, input.workspaceId)
        requireAuthorization(live, 'skills:read', { workspaceId: input.workspaceId })
      },
      perform: async (client) => {
        const head = await this.lockedHead(client, input)
        const changed = head.archived !== input.archived
        if (changed) await client.query(`update workspace_skills set archived_at=case when $3 then now() else null end,revision=revision+1,updated_at=now()
          where workspace_id=$1 and skill_id=$2`, [input.workspaceId, input.skillId, input.archived])
        const skill = changed ? await this.head(client, input.workspaceId, input.skillId) : head
        const version = verifiedVersion((await client.query<{ record: unknown }>(
          'select record from workspace_skill_versions where workspace_id=$1 and skill_id=$2 and version=$3',
          [input.workspaceId, input.skillId, skill.version])).rows[0]?.record)
        return { skill, version, changed }
      },
    })
  }

  private async authorizePublish(client: pg.PoolClient, principal: ManagementPrincipal, workspaceId: string) {
    await lockActiveWorkspace(client, workspaceId)
    const live = await readLiveManagementPrincipal(client, principal.id)
    requireAuthorization(live, 'skills:publish', { workspaceId })
    return live
  }

  private async head(client: pg.ClientBase | pg.Pool, workspaceId: string, skillId: string, lock = false): Promise<SkillSummary> {
    const row = (await client.query<HeadRow>(`${HEAD_SELECT} where s.workspace_id=$1 and s.skill_id=$2${lock ? ' for update of s' : ''}`,
      [workspaceId, skillId])).rows[0]
    if (!row) throw new DomainError('SKILL_NOT_FOUND', 'The skill was not found.', 404)
    return summary(row)
  }

  private async lockedHead(client: pg.PoolClient, input: { workspaceId: string; skillId: string; expectedRevision: number }) {
    const head = await this.head(client, input.workspaceId, input.skillId, true)
    if (head.revision !== input.expectedRevision) {
      throw new DomainError('SKILL_REVISION_CONFLICT', 'This skill changed since you opened it. Review the latest version before saving.', 409,
        { currentRevision: head.revision })
    }
    return head
  }

  /** Versions are server-allocated sequence labels; historical caller-chosen labels are skipped, never overwritten. */
  private async insertVersion(client: pg.PoolClient, workspaceId: string, skillId: string, first: number,
    content: { name: string; description?: string | undefined; instructions: string }): Promise<SkillVersion> {
    for (let sequence = first; ; sequence++) {
      const skill = SkillVersionSchema.parse({ workspaceId, skillId, version: String(sequence), name: content.name,
        ...(content.description ? { description: content.description } : {}),
        instructions: content.instructions, contentHash: skillHash(content.instructions), createdAt: new Date().toISOString() })
      const inserted = await client.query(`insert into workspace_skill_versions(workspace_id,skill_id,version,sequence,record)
        values($1,$2,$3,$4,$5::jsonb) on conflict do nothing returning version`,
      [workspaceId, skillId, skill.version, sequence, JSON.stringify(skill)])
      if (inserted.rows[0]) return skill
    }
  }
}
