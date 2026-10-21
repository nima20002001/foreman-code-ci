import { expect, it } from 'vitest'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresClaudeCallbackJournal, type ClaudeCallbackRecord } from '../src/modules/harnesses/claudeSdk/callbackJournal.js'
import { nim2691TaskDatabase } from './helpers/nim2691Database.js'

it('preserves callback acknowledgment and retirement across delayed writes and repository replacement', async () => {
  await nim2691TaskDatabase(async pool => {
    await applyApplicationMigrations(pool)
    const journal = new PostgresClaudeCallbackJournal(pool, 'operator:callback-owner')
    const record: ClaudeCallbackRecord = { identity: { ownerPrincipalId: 'principal', attemptId: 'request',
      nativeSessionId: 'session', nativeMessageId: 'message', generation: 'generation', toolUseId: 'tool',
      nativeRequestId: 'permission', nativeRequestType: 'can_use_tool' }, inputHash: 'input-hash',
      toolName: 'Read', selectedOptionId: 'allow_once', state: 'submitted', acknowledged: false }
    await journal.write('callback', record)
    await journal.write('callback', { ...record, acknowledged: true })
    await journal.write('callback', record)
    expect(await journal.acknowledged('session')).toMatchObject([{ acknowledged: true }])
    await journal.write('callback', { ...record, retired: true })
    await journal.write('callback', record)
    const recovered = new PostgresClaudeCallbackJournal(pool, 'operator:callback-owner')
    expect(await recovered.read('callback')).toMatchObject({ acknowledged: true, retired: true })
    expect(await recovered.acknowledged('session')).toEqual([])
    expect(await recovered.forTool(record.identity)).toMatchObject({ inputHash: record.inputHash })
    await expect(recovered.write('callback', { ...record, inputHash: 'changed-input' })).rejects.toThrow('different input')
    expect(await new PostgresClaudeCallbackJournal(pool, 'operator:another-owner').read('callback')).toBeUndefined()
    expect(await recovered.forTool({ ...record.identity, generation: 'another-generation' })).toBeUndefined()
  })
}, 30_000)
