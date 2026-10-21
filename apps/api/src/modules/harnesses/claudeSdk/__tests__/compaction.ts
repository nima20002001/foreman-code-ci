import { expect, vi } from 'vitest'
import { privateFixtureDirectory } from '../../../../../test/helpers/privateFixtureDirectory.js'
import { removeFixtureDirectory } from '../../../../../test/helpers/testResources.js'
import { fixture, scope, start } from './sessionManager.js'

export async function compactionFixture() {
  const profilePath = await privateFixtureDirectory('compaction-lifecycle-')
  const f = fixture(undefined, { scope: { ...scope, profilePath } })
  f.runner.compactionHistory = async () => ({
    cursor: { scope: 'scope', identity: 'identity', offset: 0 }, boundaries: [],
  })
  return { ...f, profilePath,
    async attach() {
      const session = await f.manager.attachSession({ harness: 'claude', providerVersion: '2.1.284',
        nativeSessionId: 'native-session' }, start)
      await f.frames.offer({ type: 'system', subtype: 'init', session_id: session.nativeSessionId,
        cwd: '/work', claude_code_version: '2.1.284', slash_commands: ['compact'] })
      await vi.waitFor(async () => expect((await f.manager.sessionControlCapabilities!(session)).compact.supported).toBe(true))
      return session
    },
    async dispose() {
      await f.manager.dispose!()
      await removeFixtureDirectory(profilePath)
    },
  }
}
