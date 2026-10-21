import { randomUUID } from 'node:crypto'
import type { Client } from '@modelcontextprotocol/client'
import { afterEach, beforeEach } from 'vitest'
import type { JobDefinitionRecord } from '@foreman-code/contracts/job-verification'
import { buildApp } from '../../src/app.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import type { JobService } from '../../src/modules/jobs/service.js'
import { buildQueueFixture } from './buildComputerFixture.js'
import { agent3Database } from './wave25Agent3.js'

export function setupJobAdmissionQueue() {
  let database: Awaited<ReturnType<typeof agent3Database>>
  let access: PostgresAccessService
  let writer: Awaited<ReturnType<PostgresAccessService['issue']>>
  let reader: Awaited<ReturnType<PostgresAccessService['issue']>>
  const services: JobService[] = []
  const apps: ReturnType<typeof buildApp>[] = []
  const clients: Client[] = []
  beforeEach(async () => {
    database = await agent3Database()
    access = new PostgresAccessService(database.pool)
    writer = await access.issue({ name: 'Queue writer', audience: 'operator', expiresAt: new Date(Date.now() + 3600000),
      grants: [{ actions: ['job_definitions:read', 'job_definitions:write', 'jobs:start', 'jobs:read', 'jobs:cancel',
        'settings:read', 'settings:update', 'capabilities:read'], scope: {} }] })
    reader = await access.issue({ name: 'Queue reader', audience: 'operator', expiresAt: new Date(Date.now() + 3600000),
      grants: [{ actions: ['jobs:read', 'capabilities:read'], scope: {} }] })
  }, 60000)
  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map(client => client.close()))
    await Promise.allSettled(apps.splice(0).map(app => app.close()))
    await Promise.allSettled(services.splice(0).map(service => service.closeQueue()))
    await database?.close()
  })
  async function fixture(options: Parameters<typeof buildQueueFixture>[2] = {}) {
    const authority = await access.issue({ name: 'Fixture queue writer', audience: 'operator',
      expiresAt: new Date(Date.now() + 300000), grants: writer.principal.grants })
    const f = await buildQueueFixture(database.pool, authority.principal, options)
    services.push(f.jobs)
    return f
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  function admissionTicketId(result: Awaited<ReturnType<JobService['enqueue']>>) {
    if (result.kind === 'retained-execution') throw new Error('Fresh queue requests must own a queue ticket')
    return result.kind === 'accepted' ? result.ticketId : result.ticket.id
  }
  const command = (definition: JobDefinitionRecord) => ({ commandId: randomUUID(), definitionId: definition.id,
    expectedRevision: definition.revision })
  async function submit(f: Fixture, definition: JobDefinitionRecord) {
    const result = await f.jobs.enqueue(f.principal, 'http', f.workspaceId, command(definition))
    const id = admissionTicketId(result)
    return f.jobs.getQueueTicket(reader.principal, f.workspaceId, id)
  }
  async function ordered(f: Fixture, service = f.jobs) {
    return (await service.listQueue(reader.principal, f.workspaceId))
      .sort((a, b) => Number(BigInt(a.enqueueSequence) - BigInt(b.enqueueSequence)))
  }
  return {
    get database() { return database },
    get access() { return access },
    get writer() { return writer },
    get reader() { return reader },
    services,
    apps,
    clients,
    fixture,
    admissionTicketId,
    command,
    submit,
    ordered,
  }
}
