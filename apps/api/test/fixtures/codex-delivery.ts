import { randomUUID } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CodexAppServerSessionManager, type CodexSessionDependencies } from '../../src/modules/harnesses/codexAppServer.js'
import { CodexStdioTransport, isObject } from '../../src/modules/harnesses/codexStdioTransport.js'
import type { CodexChatFiles } from '../../src/modules/harnesses/codexFiles/runtime.js'
import { calls, fixture, fixtureQualification } from './codex-test-helpers.js'
import type { NativeResponseJournal } from '../../src/modules/harnesses/recovery/responseJournal.js'

/** Native I/O uses the executable fault fixture and production stdio transport. */
export async function deliveryFixture() {
  const f = await fixture()
  const source = await readFile(f.binary, 'utf8')
  await writeFile(f.binary, source.replace(
    "if (message.method === 'initialize') result(message.id,",
    "if (message.method === 'initialize' && flag('reject-initialize')) fail(message.id)\n  else if (message.method === 'initialize') result(message.id,",
  ).replace("process.on('exit', () => { log({ exited: process.pid }) })",
    "process.on('exit', () => { log({ exited: process.pid }) })\nsetInterval(() => { if (flag('idle-exit')) process.exit(19) }, 10)"))
  const managers: CodexAppServerSessionManager[] = []
  const makeManager = (files?: CodexChatFiles,
    overrides: Omit<Partial<Extract<CodexSessionDependencies, { mode: 'native' }>>, 'mode'> = {},
    options: { appMcpAccess?: 'scoped' | 'none'; responseJournal?: NativeResponseJournal } = {}) => {
    const manager = new CodexAppServerSessionManager(f.binary, undefined, undefined, undefined,
      options.appMcpAccess ?? 'none', files, {
      mode: 'native',
      qualify: fixtureQualification,
      assertUnchanged: async () => undefined,
      transport: (...args) => {
        args[7] = 10_000
        return new CodexStdioTransport(...args)
      },
      id: randomUUID,
      ...overrides,
    }, undefined, undefined, options.responseJournal)
    managers.push(manager)
    return manager
  }
  return {
    ...f, makeManager,
    flag: (name: string) => writeFile(join(f.directory, name), ''),
    unflag: (name: string) => rm(join(f.directory, name), { force: true }),
    json: (name: string, value: unknown) => writeFile(join(f.directory, name), JSON.stringify(value)),
    wire: async (method: string) => (await calls(f.directory))
      .flatMap((entry) => isObject(entry.wire) && entry.wire.method === method ? [entry.wire] : []),
    async close() {
      try { for (const manager of managers) await manager.shutdown() }
      finally { await rm(f.directory, { recursive: true, force: true }) }
    },
  }
}
