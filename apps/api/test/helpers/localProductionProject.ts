import { execFile, type ExecFileException } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gitFixtureEnvironment } from './gitFixture.js'

const execute = promisify(execFile)

export async function createLocalProductionProject(project: string) {
  await mkdir(project)
  await writeFile(join(project, 'package.json'), '{"packageManager":"pnpm@11.27.0"}\n')
  await writeFile(join(project, 'pnpm-lock.yaml'), 'lockfileVersion: 9\npackages: {}\n')
  await writeFile(join(project, 'pnpm-workspace.yaml'), 'minimumReleaseAge: 2880\n')
  // A fixture commit must not open the host's signing UI or run its commit hooks.
  const environment = gitFixtureEnvironment()
  const git = async (args: string[]) => {
    try {
      return await execute('git', args, {
        cwd: project, env: environment, timeout: 10_000, killSignal: 'SIGKILL',
      })
    } catch (cause) {
      const failure = cause as ExecFileException
      let detail = failure.message
      if (failure.code === 'ENOENT') detail = 'Git executable "git" was not found in PATH'
      else if (failure.signal === 'SIGKILL') detail = 'Git command exceeded 10000 ms and was killed'
      throw new Error(`Cannot create production CI fixture: ${detail} (git ${args.join(' ')}).`, { cause })
    }
  }
  await git(['init', '-q'])
  await git(['add', '.'])
  await git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'])
  const { stdout } = await git(['rev-parse', 'HEAD'])
  return { commit: stdout.trim(), environment }
}
