import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const exec = promisify(execFile)

it('replays a recorded round through the offline command and reports all failures', async () => {
  const parent = process.env.FOREMAN_CODE_TEST_ROOT ?? join(homedir(), '.cache', 'foreman-tmp')
  const directory = await mkdtemp(join(parent, 'ci-replay-'))
  try {
    const path = join(directory, 'round.json')
    const recorded = JSON.parse(await readFile(new URL('./fixtures/cross-computer-ci.json', import.meta.url), 'utf8'))
    await writeFile(path, JSON.stringify(recorded), { mode: 0o600 })
    const args = ['./node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.cross-computer-ci-replay.config.mjs']
    const options = { cwd: new URL('..', import.meta.url), timeout: 20_000,
      env: { ...process.env, FOREMAN_CODE_CROSS_COMPUTER_CI_REPLAY: path,
        FOREMAN_CODE_CROSS_COMPUTER_CI_INPUT: '' } }
    expect((await exec(process.execPath, args, options)).stdout).toContain('1 passed')
    recorded.runs[0].run.outcome = 'failed'
    recorded.reports['execution-1'].logLine = 'Invented log line'
    await writeFile(path, JSON.stringify(recorded))
    await expect(exec(process.execPath, args, options)).rejects.toMatchObject({
      stderr: expect.stringMatching(/workflow.*outcome[\s\S]*logLine/i),
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
