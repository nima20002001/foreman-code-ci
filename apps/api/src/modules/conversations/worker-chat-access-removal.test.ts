import { join } from 'node:path'
import { expect, it } from 'vitest'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { privateFixtureDirectory } from '../../../test/helpers/privateFixtureDirectory.js'
import { removeFixtureDirectory } from '../../../test/helpers/testResources.js'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'

it('removes scoped Worker Agent access while retaining its saved owner, session and closure fences', async () => {
  const directory = await privateFixtureDirectory('worker-chat-access-')
  const journal = await RemoteOperationJournal.open(join(directory, 'journal.json'), { initializeNewInstallation: true })
  const f = workerConversationFixture('agent')
  const binding = { ...f.binding, appMcpAccess: 'scoped' as const }
  const reduced = { ...binding, appMcpAccess: 'none' as const }
  const chats = journal.conversations
  try {
    await chats.receive(binding, f.connection)
    await chats.reserveCreation(binding, 'initial', commandInputHash('initial'))
    await chats.bindSession(binding, f.session, f.nativeOwner)
    await expect(chats.reserveApplicationAccess(binding, { ...reduced, workingDirectory: '/different-project' },
      'wrong-directory', f.session)).rejects.toThrow()
    await chats.reserveTurn(binding, 'unfinished', commandInputHash('unfinished'))
    await expect(chats.reserveApplicationAccess(binding, reduced, 'still-active', f.session)).rejects.toThrow()
    await chats.submitted(binding, 'unfinished', { nativeTurnId: 'native-turn' })
    await chats.finishTurn(binding, 'unfinished', { outcome: 'succeeded' })
    const before = (await chats.read(binding))!
    expect(await chats.reserveApplicationAccess(binding, reduced, 'remove-tools', f.session))
      .toMatchObject({ reserved: true, applied: false })
    const owner = { ...f.nativeOwner, processIdentityDigest: 'c'.repeat(64) }
    await chats.recoveredOwner(binding, f.connection, f.nativeOwner, owner, { targetBinding: reduced })
    expect(await chats.read(reduced)).toMatchObject({ binding: reduced, session: f.session, turns: before.turns,
      nativeOwner: owner, applicationAccessChange: { state: 'applied' } })
    await expect(chats.reserveApplicationAccess(reduced, binding, 'restore-tools', f.session)).rejects.toThrow()
  } finally { await journal.close(); await removeFixtureDirectory(directory) }
})
