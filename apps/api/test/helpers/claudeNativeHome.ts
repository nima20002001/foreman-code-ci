import { chmod, copyFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { privateFixtureDirectory } from './privateFixtureDirectory.js'
import { removeFixtureDirectory } from './testResources.js'
import { referenceTestAuthenticationFile } from '../../../../scripts/test-resources.mjs'

/** Keep native test history and caches outside the user's Claude profile. */
export async function withClaudeNativeHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  const previous = process.env.CLAUDE_CONFIG_DIR
  const source = previous ?? join(homedir(), '.claude')
  const home = await privateFixtureDirectory('claude-native-home-')
  try {
    const authentication = process.env.FOREMAN_CODE_TEST_CLAUDE_AUTH_FILE ?? join(source, '.credentials.json')
    try {
      referenceTestAuthenticationFile({ directory: process.env.FOREMAN_CODE_TEST_ROOT!,
        token: process.env.FOREMAN_CODE_TEST_OWNER! }, authentication, join(home, '.credentials.json'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    for (const name of ['settings.json', '.claude.json']) {
      const destination = join(home, name)
      try {
        await copyFile(join(source, name), destination)
        await chmod(destination, 0o600)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    process.env.CLAUDE_CONFIG_DIR = home
    return await scenario(home)
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await removeFixtureDirectory(home)
  }
}
