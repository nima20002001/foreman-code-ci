import { BuildComputerPrepareStatusSchema } from '@foreman-code/contracts'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect } from 'vitest'
import { currentDatabase } from './eng04CurrentDatabase.js'
import { commit } from './ciPreparationFixture.js'
import { persistedMainPreparationFixture } from './persistedMainPreparationFixture.js'

type Fixture = Awaited<ReturnType<typeof persistedMainPreparationFixture>>
type Runtime = Awaited<ReturnType<Fixture['create']>>

export function mainPreparationRecoverySuite() {
  let database: Awaited<ReturnType<typeof currentDatabase>>
  let fixture: Fixture | undefined
  beforeEach(async () => {
    database = await currentDatabase()
  }, 60_000)
  afterEach(async () => {
    try {
      await fixture?.close()
    } finally {
      await database?.close()
      fixture = undefined
    }
  })

  const input = (f: Fixture) => ({
    workspaceId: f.fixture.workspaceId,
    profileId: 'p-main',
    commit,
    commandId: randomUUID(),
  })
  async function settle(runtime: Runtime) {
    await expect.poll(async () => (await runtime.read()).state, { timeout: 10_000, interval: 10 })
      .toMatch(/^(qualified|failed)$/u)
    return runtime.read()
  }
  async function readBoth(runtime: Runtime) {
    const status = await runtime.read()
    const response = await runtime.httpRead()
    expect(response.status).toBe(200)
    expect(BuildComputerPrepareStatusSchema.parse(await response.json())).toEqual(status)
    return status
  }

  return {
    get database() { return database },
    async createFixture(options: Parameters<typeof persistedMainPreparationFixture>[1] = {}) {
      fixture = await persistedMainPreparationFixture(database, options)
      return fixture
    },
    input,
    settle,
    readBoth,
  }
}
