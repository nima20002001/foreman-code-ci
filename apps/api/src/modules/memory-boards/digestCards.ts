import { MemoryCardSchema, type AgentNodeRef, type MemoryBoard, type MemoryCard } from '@foreman-code/contracts'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import type { SubjectAccess } from './types.js'
import { canonicalJson, nodeKey } from './identity.js'

export type DigestCard = Pick<MemoryCard, 'id' | 'revision' | 'title' | 'status' | 'reason' | 'updatedAt'> & { score: number }

function workflowNodeKey(node: Pick<AgentNodeRef, 'workflowId' | 'workflowNodeId'>): string {
  return canonicalJson({ workflowId: node.workflowId, workflowNodeId: node.workflowNodeId })
}

/** Open-card memberships are updated in the same transaction as the canonical card. */
export async function saveDigestTargets(tx: GraphTransactionSql, card: MemoryCard): Promise<void> {
  await tx.query('delete from memory_card_targets where card_id=$1', [card.id])
  if (card.status === 'done') return
  const nodes = [...card.linkedNodes, ...(card.assignee ? [card.assignee] : [])]
  const targets = [...new Set(nodes.flatMap(node => [nodeKey(node), workflowNodeKey(node)]))]
  if (!targets.length) return
  await tx.query(`insert into memory_card_targets(board_id,card_id,target_key,updated_at)
    select $1,$2,target_key,$4 from unnest($3::text[]) as targets(target_key)`,
  [card.boardId, card.id, targets, card.updatedAt])
}

export async function readDigestCards(tx: GraphTransactionSql, board: MemoryBoard, access: SubjectAccess): Promise<DigestCard[]> {
  const agent = access.subject.agent
  const nodeIds = agent.productRole === 'orchestrator'
    ? [...new Set([agent.workflowNodeId, ...access.branchNodeIds])] : [agent.workflowNodeId]
  const targets = agent.productRole === 'coder' ? [nodeKey(agent)]
    : nodeIds.map(workflowNodeId => workflowNodeKey({ workflowId: agent.workflowId, workflowNodeId }))
  const selected = new Map<string, DigestCard>()
  const add = (rows: { record: unknown }[], score: number) => {
    for (const row of rows) {
      const card = MemoryCardSchema.parse(row.record)
      if (selected.has(card.id)) continue
      selected.set(card.id, { id: card.id, revision: card.revision, title: card.title,
        status: card.status, reason: card.reason, updatedAt: card.updatedAt, score })
    }
  }
  // Each node contributes at most 20 indexed memberships before branch deduplication.
  const relevant = await tx.query<{ record: unknown }>(`select card.record from (
    select distinct candidate.card_id,candidate.updated_at
    from unnest($2::text[]) as target(key)
    cross join lateral (
      select card_id,updated_at from memory_card_targets
      where board_id=$1 and target_key=target.key
      order by updated_at desc,card_id desc limit 20
    ) candidate
    order by candidate.updated_at desc,candidate.card_id desc limit 20
  ) selected join memory_cards card on card.id=selected.card_id`, [board.id, targets])
  add(relevant.rows, 0)
  if (board.scope.kind === 'workflow' && agent.productRole === 'master') {
    const blocked = await tx.query<{ record: unknown }>(`select record from memory_cards
      where board_id=$1 and status='blocked' order by updated_at desc,id desc limit 20`, [board.id])
    add(blocked.rows, 1)
    const recent = await tx.query<{ record: unknown }>(`select record from memory_cards
      where board_id=$1 and status<>'done' order by updated_at desc,id desc limit 20`, [board.id])
    add(recent.rows, 2)
  }
  return [...selected.values()]
}
