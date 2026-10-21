import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { MAX_FILE_BYTES } from '@foreman-code/contracts/files'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresLocalHumanAccess } from '../src/modules/access/localHuman.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { OperatorChatService, PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChat.js'
import { PostgresFileConversationAuthorization } from '../src/modules/files/authorization.js'
import { PostgresFileRepository } from '../src/modules/files/postgres.js'
import { TemporaryFileService } from '../src/modules/files/service.js'
import { FileByteStorage } from '../src/modules/files/storage.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { registerFileRoutes } from '../src/routes/files.js'
import { registerOperatorChatRoutes } from '../src/routes/operatorChat.js'
import { graphRpc } from './eng04-graph-composition-fixture.js'
import { browserOwnerUpgrade } from './helpers/browserOwnerUpgrade.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { fileFixtures, fileMetadata } from './helpers/fileFixtures.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'

describe.skipIf(!postgresEnabled)('local human conversation recovery', { timeout: 60_000 }, () => {
  it.each(['mapped owner', 'default development browser'] as const)(
    'retains %s history and attachments after upgrade and restart without changing bearer access', async identity => {
    const db = await currentDatabase()
    const directory = await privateFixtureDirectory('local-human-chat-files-')
    const access = new PostgresAccessService(db.pool)
    const owner = await access.issue({ name: 'Former browser owner', audience: 'operator',
      grants: [{ actions: ManagementActionSchema.options, scope: {} }],
      expiresAt: new Date(Date.now() + 600_000) })
    if (identity === 'default development browser') {
      await db.pool.query('update management_principals set id=$1 where id=$2',
        ['principal-local-development-browser', owner.principal.id])
      owner.principal.id = 'principal-local-development-browser'
    }
    const reader = await access.issue({ name: 'Unrelated MCP reader', audience: 'operator',
      grants: [{ actions: ['operator_chat:read'], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
    const repository = new PostgresOperatorConversationRepository(db.pool)
    const operators = new PostgresOperatorRepository(db.pool)
    const managers = () => { throw new Error('Completed history must not launch native work.') }
    const authority = { current: (id: string) => access.currentOperator(id), assertConfiguration() {},
      setup: async () => { throw new Error('Completed history must not inspect launch configuration.') },
      prepare: async () => { throw new Error('Recovery must not issue launch authority.') }, release: async () => {} }
    let chat = new OperatorChatService(repository, operators, managers, db.directory, authority)
    let app: ReturnType<typeof buildApp> | undefined
    const files = () => new TemporaryFileService(new PostgresFileRepository(db.pool),
      new FileByteStorage(directory, MAX_FILE_BYTES), new PostgresFileConversationAuthorization(db.pool))
    try {
      const historyConversation = await chat.create(owner.principal, 'Original history')
      const attachment = fileFixtures.find(value => value.mediaType === 'text/markdown')!
      const uploadId = randomUUID()
      const target = { kind: 'operator' as const, conversationId: historyConversation.id }
      const storage = files()
      const allocated = await storage.allocate(owner.principal, target, { requestId: uploadId, ...fileMetadata(attachment) })
      await storage.upload(owner.principal, target, uploadId, Readable.from(attachment.bytes))
      await storage.finalize(owner.principal, target, uploadId)
      const pins = { fileId: allocated.value.file.fileId, revisionId: allocated.value.revision.revisionId }
      await repository.beginTurn(historyConversation.id, { requestId: 'original-history',
        content: 'Original attached message', attachments: [pins] }, owner.principal.id)
      await repository.finish(historyConversation.id, 'original-history',
        { outcome: 'succeeded', output: { text: 'Original answer' } }, 'original-answer')
      const history = await chat.history(historyConversation.id, owner.principal)
      const originalOwners = (await db.pool.query('select id,owner_principal_id from operator_conversations order by id')).rows
      await browserOwnerUpgrade(db.pool, owner.principal.id,
        { ownerMapping: identity === 'mapped owner' ? 'present' : 'empty' })
      await chat.shutdown()
      await applyApplicationMigrations(db.pool)
      const human = new PostgresLocalHumanAccess(db.pool, new PostgresAccessService(db.pool))
      chat = new OperatorChatService(new PostgresOperatorConversationRepository(db.pool),
        new PostgresOperatorRepository(db.pool), managers, db.directory, authority)
      app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
        operator: { access, services: { operatorChat: chat, commands: new PostgresCommandCoordinator(db.pool) } as never },
        localHuman: human })
      registerOperatorChatRoutes(app, chat)
      registerFileRoutes(app, files())
      await chat.reconcileActive()
      const list = await app.inject({ url: '/api/operator/conversations' })
      expect(list.statusCode, list.body).toBe(200)
      expect(list.json().conversations.map((value: { id: string }) => value.id).sort())
        .toEqual([historyConversation.id])
      expect(await chat.history(historyConversation.id, await human.current())).toEqual(history)
      const download = await app.inject({
        url: `/api/operator/conversations/${historyConversation.id}/files/${pins.fileId}/revisions/${pins.revisionId}/content`,
      })
      expect(download.statusCode, download.body).toBe(200)
      expect(download.rawPayload).toEqual(attachment.bytes)
      const denied = await graphRpc(app, reader.token, 'tools/call',
        { name: 'operator_chat_get', arguments: { conversationId: historyConversation.id } })
      expect(denied.result?.isError).toBe(true)
      expect(await access.authenticate(reader.token)).toEqual(reader.principal)
      expect(await access.authenticate(owner.token)).toEqual(owner.principal)
      expect((await db.pool.query('select id,owner_principal_id from operator_conversations order by id')).rows)
        .toEqual(originalOwners)
    } finally {
      await app?.close()
      await chat.shutdown()
      await db.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
