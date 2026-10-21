import { createHash } from 'node:crypto'
import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { MAX_AGENT_INSTRUCTIONS_BYTES, type ResolvedSkill } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { agentInstructionBundle } from '../skills/instructions.js'
import { CurrentWorkflowAuthoring } from './currentAuthoring.js'
import { PostgresWorkflowRepository } from './postgres.js'

const hash = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`

function fixture() {
  const workflow = makeCurrentWorkflowFixture('node-skills', 'sequential')
  const configuration = workflow.configurations[0]!
  const node = workflow.version.definition.nodes[0]!
  if ('kind' in node && (node.kind as string) === 'job') throw new Error('An Agent node is required')
  const skill = { workspaceId: workflow.scope.workspaceId, skillId: 'review-guide', version: '1',
    name: 'Review guide', instructions: 'Check the result.', contentHash: hash('Check the result.'),
    createdAt: '2026-01-01T00:00:00Z' }
  node.skills = { add: [{ skillId: skill.skillId, version: skill.version }] }
  configuration.instructionDelivery = 'native-v1'
  const principal: ManagementPrincipal = { id: 'operator', name: 'Operator', audience: 'operator',
    expiresAt: '2099-01-01T00:00:00Z', revokedAt: null,
    grants: [{ actions: ['workflows:read', 'workflows:update', 'graph:read', 'graph:edit', 'graph:save',
      'agents:read', 'workspace_locations:read', 'skills:read'], scope: {} }] }
  let archived = false
  let saved: unknown
  const query = vi.fn(async (text: string, values?: unknown[]) => {
    let rows: unknown[] = []
    if (text.includes('from workspaces')) rows = [{ archived_at: null }]
    else if (text.includes('record,revision::text,current_version_id,archived_at from workflows')) {
      rows = [{ record: workflow.version.definition, revision: '1', current_version_id: null, archived_at: null }]
    } else if (text.includes('from agents where')) {
      rows = workflow.configurations.map(config => ({ id: config.agentId, current_configuration_version_id: config.id }))
    } else if (text.includes('from agent_configuration_versions')) {
      rows = workflow.configurations.map(record => ({ id: record.id, workspace_id: record.workspaceId,
        agent_id: record.agentId, version: record.version, record }))
    } else if (text.includes('coalesce(max(version),0)+1')) rows = [{ next: '2' }]
    else if (text.includes('from workspace_skills')) rows = [{ archived_at: archived ? new Date() : null }]
    else if (text.includes('from workspace_skill_versions')) rows = [{ record: skill }]
    else if (text.startsWith('insert into workflow_versions')) saved = JSON.parse(values![5] as string)
    else if (text.includes('eng04_publish_current_workflow')) rows = [{ revision: '2' }]
    else if (text.includes('from management_principals')) rows = [{ id: principal.id, name: principal.name,
      audience: principal.audience, grants: principal.grants, expires_at: new Date(principal.expiresAt),
      revoked_at: null, delegated_from: null }]
    else if (text.includes('from workflow_versions') && saved) {
      const record = saved as typeof workflow.version
      rows = [{ id: record.id, workspace_id: record.workspaceId, workflow_id: record.workflowId,
        version: record.version, entry_node_id: record.entryNodeId, execution_semantics_version: 3, record }]
    }
    return { rows, rowCount: rows.length }
  })
  const client = { query, release: vi.fn() } as unknown as pg.PoolClient
  const pool = { connect: async () => client, query } as unknown as pg.Pool
  const commands = { recordAudit: vi.fn() } as unknown as PostgresCommandCoordinator
  const authoring = new CurrentWorkflowAuthoring(pool, commands)
  const save = () => authoring.saveInitial(client, principal, 'http', {
    workspaceId: workflow.scope.workspaceId, workflowId: workflow.scope.workflowId,
    expectedRevision: 1, expectedWorkflowVersionId: null, executionSemanticsVersion: 3,
    expectedAgentConfigurationVersionIds: workflow.version.agentConfigurationVersionIds,
    graph: workflow.version.definition,
  })
  return { configuration, node, skill, query, pool, save, archive: () => { archived = true } }
}

describe('node skill publication', () => {
  it('saves added instructions with their versions and observes them after archival without catalog reads', async () => {
    const f = fixture()
    const saved = await f.save()
    const repository = new PostgresWorkflowRepository(f.pool)
    const version = await repository.getSavedVersion(saved.version.id)
    const snapshots = (version as typeof version & { nodeSkillSnapshots?: Record<string, ResolvedSkill[]> })
      ?.nodeSkillSnapshots?.[f.node.id]
    expect(snapshots).toMatchObject([{ skillId: f.skill.skillId, version: f.skill.version,
      instructions: f.skill.instructions, contentHash: f.skill.contentHash }])
    f.archive()
    f.query.mockClear()
    for (let observation = 0; observation < 2; observation++) {
      const effective = await repository.resolveNodeSkills(f.configuration, f.node.skills!, snapshots)
      expect(agentInstructionBundle(effective)?.text).toContain(f.skill.instructions)
      expect(effective.assignedSkills).toEqual(f.node.skills!.add)
    }
    expect(f.query).not.toHaveBeenCalled()
  })

  it('rejects newly added archived versions before publication', async () => {
    const f = fixture()
    f.archive()
    await expect(f.save()).rejects.toMatchObject({ code: 'SKILL_ARCHIVED' })
  })

  it('rejects combined instructions above 512 KiB before publishing a version', async () => {
    const f = fixture()
    f.configuration.prompt.system = 'x'.repeat(MAX_AGENT_INSTRUCTIONS_BYTES - 10)
    await expect(f.save()).rejects.toMatchObject({ code: 'AGENT_INSTRUCTIONS_TOO_LARGE' })
    await expect(new PostgresWorkflowRepository(f.pool).getSavedVersion('unsaved-version')).resolves.toBeUndefined()
  })

  it('accepts the complete effective instructions at the byte limit', async () => {
    const f = fixture()
    const skillText = `# Skill: ${f.skill.name} (${f.skill.skillId}@${f.skill.version})\n\n${f.skill.instructions}`
    f.configuration.prompt.system = 'x'.repeat(MAX_AGENT_INSTRUCTIONS_BYTES - Buffer.byteLength(skillText) - 2)
    await expect(f.save()).resolves.toHaveProperty('version.id')
  })
})
