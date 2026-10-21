import type { AgentSubject, BoardDigest, LogicalWorkRef, MemoryBoardScope } from '@foreman-code/contracts'
import { MemoryNoteSchema } from '@foreman-code/contracts'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import type { MemoryBoardAuthority } from './types.js'
import { findScopeBoard } from './repository.js'
import { same } from './identity.js'
import { DomainError } from '../errors.js'
import { readDigestCards, type DigestCard } from './digestCards.js'

export function clipUtf8(value: string, budget: number): string {
  if (Buffer.byteLength(value) <= budget) return value
  let result = '', bytes = 0
  for (const character of value) {
    const size = Buffer.byteLength(character)
    if (bytes + size > budget) break
    result += character; bytes += size
  }
  return result
}
export async function readDigest(tx: GraphTransactionSql, authority: MemoryBoardAuthority,
  input: { subject: AgentSubject; work?: LogicalWorkRef }): Promise<BoardDigest> {
  const access = await authority.subject(tx,input.subject)
  if (!same(access.subject,input.subject)) throw new DomainError('ACCESS_DENIED','The saved agent identity has changed.',403)
  if (!access.tools.includes('memory_board_get')) return { text:'',cardIds:[],byteLength:0,omittedCount:0 }
  const agent = input.subject.agent
  const scopes: MemoryBoardScope[] = [
    { kind:'workspace',workspaceId:agent.workspaceId },
    { kind:'workflow',workspaceId:agent.workspaceId,workflowId:agent.workflowId },
  ]
  const cards: DigestCard[] = []
  const notes: { id:string; revision:number; text:string }[] = []
  let total = 0
  for (const scope of scopes) {
    await authority.scope(tx,scope)
    const row = await findScopeBoard(tx,scope)
    if (!row) continue
    total += row.counts.todo + row.counts.doing + row.counts.waiting_for_user + row.counts.blocked
    cards.push(...await readDigestCards(tx,row.board,access))
    const noteRows = await tx.query<{record:unknown}>('select record from memory_notes where board_id=$1 and archived=false order by rank,id limit 20',[row.board.id])
    for (const entry of noteRows.rows) { const note = MemoryNoteSchema.parse(entry.record); notes.push({id:note.id,revision:note.revision,text:note.text}) }
  }
  cards.sort((a,b) => a.score-b.score || b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
  let selected = cards.slice(0,20)
  const noteLines: string[] = []
  let noteBytes = 0
  for (const note of notes) {
    const prefix = `${note.id} r${note.revision}: `
    const available = 4096-noteBytes-Buffer.byteLength(prefix)-1
    if (available <= 0) break
    const line = prefix+clipUtf8(note.text,available)
    noteLines.push(line); noteBytes += Buffer.byteLength(line)+1
  }
  const render = () => ['Memory boards (live tasks; existing titles include Done).',
    ...selected.map(card => `${card.id} r${card.revision} [${card.status}] ${card.title}${card.reason ? ` — ${card.reason}` : ''}`),
    `Other open board cards omitted: ${Math.max(0,total-selected.length)}. Read more with memory_board_get.`,
    ...(noteLines.length ? ['Pinned Notes:',...noteLines] : [])].join('\n')
  let text = render()
  while (Buffer.byteLength(text)>12288 && selected.length) { selected=selected.slice(0,-1);text=render() }
  return { text,cardIds:selected.map(card=>card.id),byteLength:Buffer.byteLength(text),omittedCount:Math.max(0,total-selected.length) }
}
