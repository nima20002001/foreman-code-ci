import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { DEFAULT_HARNESS_DEFAULTS, AgentConfigurationVersionSchema, AgentSchema } from '@foreman-code/contracts'
import { WorkflowDefinitionV3Schema, WorkflowVersionV3Schema, ExecutableWorkflowV3Schema, canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { ensureAcceptanceSeed } from '../src/infrastructure/seed.js'
import { readImmutableWorkflowVersion } from '../src/modules/workflows/immutableRead.js'

interface Statement { text: string; values: readonly unknown[] }
function seedDatabase(failInsert = false) {
  const statements: Statement[] = []
  const query = vi.fn(async (text: string, values: readonly unknown[] = []) => {
    statements.push({ text: text.replace(/\s+/g, ' ').trim(), values })
    if (failInsert && /insert into workflow_versions/.test(text)) throw new Error('seed insert rejected')
    return { rows: [], rowCount: 1 }
  })
  const release = vi.fn()
  const pool = { connect: vi.fn(async () => ({ query, release })) } as unknown as pg.Pool
  return { statements, pool, release }
}
const record = (statement: Statement, index: number): unknown => JSON.parse(String(statement.values[index]))

describe('ENG07 R01 clean-start seed uses real current V3 read contracts', () => {
  it('seeds an executable ordinary V3 graph with explicit physical and JSON pins and a verifiable hash', async () => {
    const db = seedDatabase()
    await ensureAcceptanceSeed(db.pool)
    const one = (table: string) => db.statements.find((statement) => statement.text.startsWith(`insert into ${table} (`))!
    const workflow = WorkflowDefinitionV3Schema.parse(record(one('workflows'), 3))
    const statement = one('workflow_versions')
    const version = WorkflowVersionV3Schema.parse(record(statement, 5))
    const configurations = db.statements.filter((item) => item.text.startsWith('insert into agent_configuration_versions '))
      .map((item) => AgentConfigurationVersionSchema.parse(record(item, 4)))
    const agents = db.statements.filter((item) => item.text.startsWith('insert into agents '))
      .map((item) => AgentSchema.parse(record(item, 3)))

    expect(workflow).toEqual(version.definition)
    expect(workflow.executionSemanticsVersion).toBe(3)
    expect(version.executionSemanticsVersion).toBe(3)
    expect(workflow).not.toHaveProperty('repeat')
    expect(workflow.edges.map((edge) => edge.kind)).toEqual(['execution', 'execution'])
    expect(workflow.edges.every((edge) => !Object.hasOwn(edge, 'route'))).toBe(true)
    expect(workflow.entryNodeId).toBe('node-researcher')
    expect(configurations.map((configuration) => configuration.productRole)).toEqual(['coder', 'coder', 'coder'])
    expect(agents.map((agent) => agent.productRole)).toEqual(['coder', 'coder', 'coder'])
    expect(configurations.map((configuration) => configuration.harness.harness)).toEqual(['codex', 'codex', 'codex'])
    expect(configurations[1]!.harness.model).toBe(DEFAULT_HARNESS_DEFAULTS.codex.model)
    expect(ExecutableWorkflowV3Schema.parse({ version, configurations })).toEqual({ version, configurations })
    expect(statement.text).toMatch(/execution_semantics_version\) values \(\$1, \$2, \$3, \$4, \$5, \$6::jsonb, 3\)/)
    expect(version.contentHash).toBe(`sha256:${createHash('sha256').update(canonicalGraphJson({
      definition: workflow, configurations: version.agentConfigurationVersionIds, entryNodeId: version.entryNodeId,
    })).digest('hex')}`)
    expect(readImmutableWorkflowVersion({
      id: String(statement.values[0]), workspace_id: String(statement.values[1]), workflow_id: String(statement.values[2]),
      version: Number(statement.values[3]), entry_node_id: String(statement.values[4]), execution_semantics_version: 3,
      record: version,
    })).toEqual(version)
    expect(db.statements[0]!.text).toBe('begin')
    expect(db.statements.at(-1)!.text).toBe('commit')
    expect(db.release).toHaveBeenCalledOnce()
  })

  it('never repairs or converts a retired seed record during current immutable read', async () => {
    const db = seedDatabase()
    await ensureAcceptanceSeed(db.pool)
    const statement = db.statements.find((item) => item.text.startsWith('insert into workflow_versions '))!
    const version = WorkflowVersionV3Schema.parse(record(statement, 5))
    const row = { id: version.id, workspace_id: version.workspaceId, workflow_id: version.workflowId,
      version: version.version, entry_node_id: version.entryNodeId, execution_semantics_version: 3, record: version }
    for (const tag of [undefined, null, 1, 2, '3', 4]) {
      const bad = { ...version, executionSemanticsVersion: tag }
      const before = structuredClone(bad)
      expect(() => readImmutableWorkflowVersion({ ...row, record: bad })).toThrow()
      expect(bad).toEqual(before)
      expect(() => readImmutableWorkflowVersion({ ...row, record: { ...version,
        definition: { ...version.definition, executionSemanticsVersion: tag } } })).toThrow()
    }
    for (const execution_semantics_version of [1, 2, 4]) {
      expect(() => readImmutableWorkflowVersion({ ...row, execution_semantics_version })).toThrow('Only explicitly pinned current execution semantics 3')
    }
    expect(() => readImmutableWorkflowVersion({ ...row, record: { ...version, contentHash: `sha256:${'0'.repeat(64)}` } }))
      .toThrow('content hash does not match')
  })

  it('keeps insert-only repeatability, with no migration, trigger disable or retagging update', async () => {
    const db = seedDatabase()
    await ensureAcceptanceSeed(db.pool)
    const first = structuredClone(db.statements)
    await ensureAcceptanceSeed(db.pool)
    expect(db.statements.slice(first.length)).toEqual(first)
    const inserts = first.filter((statement) => statement.text.startsWith('insert into '))
    expect(inserts).toHaveLength(9)
    expect(inserts.every((statement) => statement.text.endsWith('on conflict (id) do nothing'))).toBe(true)
    expect(first.every((statement) => statement.text === 'begin' || statement.text === 'commit' || statement.text.startsWith('insert into '))).toBe(true)
  })

  it('rolls back and releases the owned client when an insert fails', async () => {
    const db = seedDatabase(true)
    await expect(ensureAcceptanceSeed(db.pool)).rejects.toThrow('seed insert rejected')
    expect(db.statements.at(-1)!.text).toBe('rollback')
    expect(db.statements.some((statement) => statement.text === 'commit')).toBe(false)
    expect(db.release).toHaveBeenCalledOnce()
  })
})
