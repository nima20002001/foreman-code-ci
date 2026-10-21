import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'
import { WorkerConversationArchive } from './workerConversationArchive.js'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { WorkerConversationReceipt } from '@foreman-code/contracts/remote-execution-rpc'

it('persists replacement generations independently and retains both closed receipts after archive and restart', async () => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(join(cache, 'worker-chat-replacement-'))
  const path = join(directory, 'operations.json')
  let now = Date.now()
  let journal = await RemoteOperationJournal.open(path, { initializeNewInstallation: true,
    now: () => now, retentionNow: () => now })
  const f = workerConversationFixture('agent')
  if (f.binding.owner.kind !== 'agent') throw new Error('Agent conversation required')
  const replacement = { ...f.binding, generation: randomUUID(), owner: { ...f.binding.owner,
    configurationVersionId: randomUUID() } }
  try {
    await journal.conversations.receive(f.binding, f.connection)
    await journal.conversations.reserveCreation(f.binding, 'first', `sha256:${'a'.repeat(64)}`)
    await journal.conversations.bindSession(f.binding, f.session, f.nativeOwner)
    await expect(journal.conversations.receive(replacement, f.connection)).rejects.toThrow()
    await journal.conversations.closeRequested(f.binding)
    const original = await journal.conversations.closeConfirmed(f.binding)
    await journal.conversations.receive(replacement, f.connection)
    await journal.conversations.reserveCreation(replacement, 'replacement', `sha256:${'b'.repeat(64)}`)
    const session = { ...f.session, nativeSessionId: 'replacement-session' }
    await journal.conversations.bindSession(replacement, session, { ...f.nativeOwner, sessionId: session.nativeSessionId })
    await journal.conversations.closeRequested(replacement)
    const replaced = await journal.conversations.closeConfirmed(replacement)
    await expect(journal.conversations.read(f.binding)).resolves.toEqual(original)
    await expect(journal.conversations.read(replacement)).resolves.toEqual(replaced)
    now += 31 * 24 * 60 * 60_000
    await journal.pruneFinishedRuntime()
    await journal.close()
    journal = await RemoteOperationJournal.open(path, { now: () => now, retentionNow: () => now })
    await expect(journal.conversations.read(f.binding)).resolves.toEqual(original)
    await expect(journal.conversations.read(replacement)).resolves.toEqual(replaced)
    await expect(journal.conversations.reserveCreation(replacement, 'duplicate', `sha256:${'c'.repeat(64)}`))
      .rejects.toThrow()
    await expect(journal.conversations.receive({ ...replacement, generation: randomUUID(),
      owner: { ...replacement.owner, conversationId: f.binding.owner.conversationId, agentId: 'another-agent' } }, f.connection))
      .rejects.toThrow()
  } finally {
    await journal.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('keeps the saved archive unchanged when one generation exceeds its existing byte limit', async () => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(join(cache, 'worker-chat-archive-'))
  const f = workerConversationFixture('agent')
  const record: WorkerConversationReceipt = { binding: f.binding, connection: f.connection,
    revision: 1, closed: true, closing: true, desiredPreferences: null, appliedPreferences: null,
    turns: [{ correlationId: 'completed', inputHash: `sha256:${'a'.repeat(64)}`, status: 'completed',
      nativeTurnId: 'original-turn', result: { outcome: 'succeeded', output: 'Saved result '.repeat(200) } }], compactions: [] }
  const byteLimit = Buffer.byteLength(JSON.stringify({ receipt: record, digest: commandInputHash(record) }))
  const archive = new WorkerConversationArchive(join(directory, 'operations.json'), byteLimit, async (path, value) => {
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, value)
  })
  const generation = randomUUID()
  try {
    await archive.save(record)
    await expect(archive.save({ ...record, binding: { ...record.binding, generation },
      turns: [{ ...record.turns[0]!, result: { outcome: 'succeeded', output: 'x'.repeat(byteLimit + 1024) } }] }))
      .rejects.toThrow('byte limit')
    await expect(archive.read(f.binding.owner.conversationId)).resolves.toEqual(record)
    await expect(archive.read(f.binding.owner.conversationId, generation)).resolves.toBeUndefined()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('retains individually bounded generations without blocking unrelated journal writes or restart', async () => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(join(cache, 'worker-chat-retention-'))
  const path = join(directory, 'operations.json')
  let now = Date.now()
  const options = { now: () => now, retentionNow: () => now }
  let journal = await RemoteOperationJournal.open(path, { ...options, initializeNewInstallation: true })
  const f = workerConversationFixture('agent')
  const bindings = [f.binding, { ...f.binding, generation: randomUUID() }]
  const receipts: WorkerConversationReceipt[] = []
  const unrelated = workerConversationFixture()
  try {
    for (const [index, binding] of bindings.entries()) {
      await journal.conversations.receive(binding, f.connection)
      await journal.conversations.reserveCreation(binding, `create-${index}`, commandInputHash(index))
      const session = { ...f.session, nativeSessionId: `session-${index}` }
      await journal.conversations.bindSession(binding, session, { ...f.nativeOwner, sessionId: session.nativeSessionId })
      await journal.conversations.reserveTurn(binding, 'turn', commandInputHash('turn'))
      await journal.conversations.finishTurn(binding, 'turn', {
        outcome: 'succeeded', output: String(index).repeat(2304 * 1024),
      })
      await journal.conversations.closeRequested(binding)
      receipts.push(await journal.conversations.closeConfirmed(binding))
      now += 31 * 24 * 60 * 60_000
      await expect(journal.conversations.receive(unrelated.binding, unrelated.connection))
        .resolves.toMatchObject({ closed: false })
    }
    await journal.close()
    journal = await RemoteOperationJournal.open(path, options)
    for (const [index, binding] of bindings.entries()) {
      await expect(journal.conversations.read(binding)).resolves.toEqual(receipts[index])
      await expect(journal.conversations.reserveCreation(binding, 'replay', commandInputHash('replay'))).rejects.toThrow()
    }
    const another = workerConversationFixture()
    await expect(journal.conversations.receive(another.binding, another.connection)).resolves.toMatchObject({ closed: false })
  } finally {
    await journal.close()
    await rm(directory, { recursive: true, force: true })
  }
})
