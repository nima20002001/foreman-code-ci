import type pg from 'pg'
import { HarnessExecutionError } from '../errors.js'

export interface ClaudeCallbackIdentity {
  /** Current owned SDK callback lifetime, supplied by the native manager. */
  generation?: string
  nativeRequestType?: 'can_use_tool'
  ownerPrincipalId: string
  nativeSessionId: string
  nativeTurnId?: string
  nativeMessageId?: string
  clientCorrelationId?: string
  attemptId: string
  toolUseId: string
  /** Control request ID, distinct from tool_use and message IDs; absent on PreToolUse hooks. */
  nativeRequestId?: string
  agentId?: string
  parentToolUseId?: string
  mcpServer?: { name: string; source: string }
}

export interface ClaudeCallbackRecord {
  identity: ClaudeCallbackIdentity
  inputHash: string
  toolName: string
  selectedOptionId?: string
  state: 'submitted' | 'uncertain'
  acknowledged: boolean
  retired?: boolean
}
export interface ClaudeCallbackJournal {
  read(key: string): Promise<ClaudeCallbackRecord | undefined>
  write(key: string, record: ClaudeCallbackRecord): Promise<void>
  forTool(identity: ClaudeCallbackIdentity): Promise<ClaudeCallbackRecord | undefined>
  acknowledged(nativeSessionId: string): Promise<ClaudeCallbackRecord[]>
}

export class PostgresClaudeCallbackJournal implements ClaudeCallbackJournal {
  constructor(private readonly database: Pick<pg.Pool, 'query'>, private readonly owner: string) {}
  async read(key: string): Promise<ClaudeCallbackRecord | undefined> {
    return (await this.database.query<{ record: ClaudeCallbackRecord }>(`select record from claude_callback_receipts
      where owner_key=$1 and callback_key=$2`, [this.owner, key])).rows[0]?.record
  }
  async write(key: string, record: ClaudeCallbackRecord): Promise<void> {
    const saved = await this.database.query(`insert into claude_callback_receipts(owner_key,callback_key,input_hash,record)
      values($1,$2,$3,$4::jsonb) on conflict(owner_key,callback_key) do update set record=excluded.record
        || jsonb_build_object('acknowledged',
          (claude_callback_receipts.record->>'acknowledged')::boolean or (excluded.record->>'acknowledged')::boolean,
          'retired',coalesce((claude_callback_receipts.record->>'retired')::boolean,false)
            or coalesce((excluded.record->>'retired')::boolean,false))
      where claude_callback_receipts.input_hash=excluded.input_hash
        and claude_callback_receipts.record->'identity'=excluded.record->'identity'
        and claude_callback_receipts.record->>'state'=excluded.record->>'state'
        and (claude_callback_receipts.record->>'selectedOptionId') is not distinct from (excluded.record->>'selectedOptionId')
      returning callback_key`,
    [this.owner, key, record.inputHash, JSON.stringify(record)])
    if (saved.rowCount !== 1) throw new HarnessExecutionError('CLAUDE_CALLBACK_CONFLICT',
      'The callback identity was reused with different input.')
  }
  async forTool(identity: ClaudeCallbackIdentity): Promise<ClaudeCallbackRecord | undefined> {
    const rows = (await this.database.query<{ record: ClaudeCallbackRecord }>(`select record from claude_callback_receipts
      where owner_key=$1 and record#>>'{identity,nativeSessionId}'=$2 and record#>>'{identity,nativeMessageId}'=$3
        and record#>>'{identity,generation}'=$4 and record#>>'{identity,toolUseId}'=$5`,
    [this.owner, identity.nativeSessionId, identity.nativeMessageId, identity.generation, identity.toolUseId])).rows
    return rows.length === 1 ? rows[0]!.record : undefined
  }
  async acknowledged(nativeSessionId: string): Promise<ClaudeCallbackRecord[]> {
    return (await this.database.query<{ record: ClaudeCallbackRecord }>(`select record from claude_callback_receipts
      where owner_key=$1 and record#>>'{identity,nativeSessionId}'=$2
        and record->>'acknowledged'='true' and coalesce(record->>'retired','false')='false'`,
    [this.owner, nativeSessionId])).rows.map(row => row.record)
  }
}
