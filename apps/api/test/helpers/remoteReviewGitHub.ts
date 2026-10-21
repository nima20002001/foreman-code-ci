import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { gitFixtureEnvironment } from './gitFixture.js'

const execute = promisify(execFile)

/** Private Git configuration routes the production GitHub clone/fetch/push flow to an offline remote. */
export async function configureRemoteReviewGitHub(input: {
  project: string
  origin: string
  repository: string
  homes: readonly string[]
}): Promise<void> {
  const options = { env: gitFixtureEnvironment() }
  await execute('git', ['clone', '--quiet', '--bare', '--no-local', '--template=', input.project, input.origin], options)
  const remote = pathToFileURL(input.origin).href
  for (const fixtureHome of input.homes) {
    await mkdir(fixtureHome, { recursive: true, mode: 0o700 })
    await execute('git', ['config', '--file', join(fixtureHome, '.gitconfig'),
      `url.${remote}.insteadOf`, `https://github.com/${input.repository}.git`], options)
  }
}
