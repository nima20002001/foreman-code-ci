import { chmod, copyFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { privateFixtureDirectory } from './privateFixtureDirectory.js'
import { removeFixtureDirectory } from './testResources.js'
import { referenceTestAuthenticationFile } from '../../../../scripts/test-resources.mjs'

/** Keep native test sessions and caches outside the user's Codex storage. */
export async function withCodexNativeHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  const previous = process.env.CODEX_HOME
  const source = previous ?? join(homedir(), '.codex')
  const home = await privateFixtureDirectory('codex-native-home-')
  try {
    const authentication = process.env.FOREMAN_CODE_TEST_CODEX_AUTH_FILE ?? join(source, 'auth.json')
    try {
      referenceTestAuthenticationFile({ directory: process.env.FOREMAN_CODE_TEST_ROOT!,
        token: process.env.FOREMAN_CODE_TEST_OWNER! }, authentication, join(home, 'auth.json'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    for (const name of ['config.toml']) {
      const destination = join(home, name)
      try {
        await copyFile(join(source, name), destination)
        await chmod(destination, 0o600)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    process.env.CODEX_HOME = home
    return await scenario(home)
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previous
    await removeFixtureDirectory(home)
  }
}
