import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { groupUsed, stopGroup } from './integration-process.mjs'

const watchdog = fileURLToPath(new URL('./ci-watchdog.mjs', import.meta.url))
const parent = join(homedir(), '.cache', 'foreman-tmp')
mkdirSync(parent, { recursive: true })

for (const orphaned of [false, true]) {
  test(`metrics failure still stops detached coordinators and workers (orphaned: ${orphaned})`,
    { timeout: 15_000 }, async t => {
      const directory = mkdtempSync(join(parent, 'watchdog-detached-workers-'))
      const pids = () => ['coordinator.pid', 'worker.pid'].filter(file => existsSync(join(directory, file)))
        .map(file => Number(readFileSync(join(directory, file), 'utf8')))
      writeFileSync(join(directory, 'worker.cjs'), `
        const { writeFileSync } = require('node:fs')
        process.on('SIGTERM', () => {})
        writeFileSync('worker.pid', String(process.pid))
        setInterval(() => {}, 1000)
      `)
      writeFileSync(join(directory, 'coordinator.cjs'), `
        const { spawn } = require('node:child_process')
        const { writeFileSync } = require('node:fs')
        process.on('SIGTERM', () => {})
        spawn(process.execPath, ['worker.cjs'], { detached: true, stdio: 'ignore' }).unref()
        writeFileSync('coordinator.pid', String(process.pid))
        ${orphaned ? 'setTimeout(() => process.exit(0), 400)' : 'setInterval(() => {}, 1000)'}
      `)
      const source = `
        const { spawn } = require('node:child_process')
        spawn(process.execPath, ['coordinator.cjs'], { detached: true, stdio: 'ignore' }).unref()
        setInterval(() => {}, 1000)
      `
      const child = spawn(process.execPath, [watchdog, '--', process.execPath, '-e', source], {
        cwd: directory, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: directory, CI_EXPECTED_DURATION_MS: '0', CI_WATCHDOG_IDLE_MS: '1500',
          CI_WATCHDOG_DIRECTORY: directory },
      })
      t.after(async () => {
        await stopGroup(child.pid, { graceMs: 100 })
        for (const pid of pids()) await stopGroup(pid, { graceMs: 100 })
        rmSync(directory, { recursive: true, force: true })
      })
      let output = ''
      child.stdout.on('data', bytes => { output += bytes })
      child.stderr.on('data', bytes => { output += bytes })
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
      })
      assert.equal(code, 1, output)
      assert.match(output, /process metrics unavailable/)
      assert.match(output, /getconf.*ENOENT/)
      assert.match(output, /no test progress for 1500 ms/)
      assert.equal(pids().length, 2, 'both detached process groups must have started')
      for (const pid of pids()) assert.equal(groupUsed(pid), false, `detached group ${pid} survived watchdog shutdown`)
    })
}
