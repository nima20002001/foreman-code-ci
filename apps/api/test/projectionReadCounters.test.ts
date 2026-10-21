import { expect, it } from 'vitest'
import { ProjectionDatabase, projectionScope } from './eng04-projection-fixture.js'

const scopeValues = [projectionScope.runId, projectionScope.workspaceId,
  projectionScope.workflowId, projectionScope.workflowVersionId]
const reads: Array<{ name: string; statement: string; values: unknown[];
  counter: 'headReads' | 'historyBodyReads' }> = [
  { name: 'locked head', statement: `select protocol_version,head_sequence::text as sequence
      from run_graph_heads where run_id=$1 for update`, values: [projectionScope.runId], counter: 'headReads' },
  { name: 'head position', statement: 'select head_sequence::text as sequence from run_graph_heads where run_id=$1',
    values: [projectionScope.runId], counter: 'headReads' },
  { name: 'head protocol', statement: 'select protocol_version from run_graph_heads where run_id=$1',
    values: [projectionScope.runId], counter: 'headReads' },
  { name: 'scoped head', statement: `select h.head_sequence from run_graph_heads h join runs r on r.id=h.run_id
      where r.id=$1 and r.workspace_id=$2 and r.workflow_id=$3 and r.workflow_version_id=$4`,
    values: scopeValues, counter: 'headReads' },
  { name: 'head source proof', statement: `select h.head_sequence::text,latest.source_revision
      from run_graph_heads h left join lateral (select s.source_revision from run_graph_sources s
        where s.run_id=h.run_id order by s.source_revision desc limit 1) latest on true where h.run_id=$1`,
    values: [projectionScope.runId], counter: 'headReads' },
  { name: 'public projection proof', statement: `select p.record,p.source_digest,p.semantic_digest,p.sequence::text,
      s.first_sequence::text as proof_sequence from run_graph_public_projection p left join run_graph_sources s
      on s.run_id=p.run_id and s.source_id=$2 and s.source_revision=p.sequence where p.run_id=$1`,
    values: [projectionScope.runId, 'projection-proof'], counter: 'headReads' },
  { name: 'source receipt', statement: `select source_digest,semantic_digest from run_graph_sources
      where run_id=$1 and source_kind=$2 and source_id=$3 and source_revision=$4::bigint`,
    values: [projectionScope.runId, 'run', 'source', '1'], counter: 'headReads' },
  { name: 'effect receipt', statement: `select effect_digest,semantic_digest from run_graph_effects
      where run_id=$1 and effect_kind=$2 and entity_id=$3`,
    values: [projectionScope.runId, 'input.bind', 'effect'], counter: 'headReads' },
  { name: 'batch headers', statement: `select b.sequence::text,b.kind,b.payload_bytes from run_graph_batches b
      where b.run_id=$1 and b.sequence>$2::bigint and b.sequence<=$3::bigint order by b.sequence limit $4`,
    values: [projectionScope.runId, '0', '1', 10], counter: 'historyBodyReads' },
  { name: 'batch payloads', statement: `select b.sequence::text,b.payload from run_graph_batches b
      where b.run_id=$1 and b.sequence=any($2::bigint[]) order by b.sequence`,
    values: [projectionScope.runId, ['1']], counter: 'historyBodyReads' },
]

for (const read of reads) it(`makes the denial assertion reject a ${read.name} read`, async () => {
  const db = new ProjectionDatabase()
  await db.initialize()
  db.assertNoProtectedGraphReads()
  const connection = db.connection()
  try {
    await connection.transaction(sql => sql.query(read.statement, read.values))
    expect(db[read.counter]).toBe(1)
    expect(() => db.assertNoProtectedGraphReads()).toThrow()
  } finally { await connection.close() }
})
