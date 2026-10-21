import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { URL } from 'node:url'
import process from 'node:process'

// Keep the CI smoke entry, exercising the registered route and shared editor.
test('saved workflows reopen and finite repeat removal persists through the Board', async () => {
  const child = spawn('corepack', ['pnpm', 'exec', 'vitest', 'run',
    'src/features/workflow-board/currentBoardAuthoring.integration.test.tsx',
    '-t', 'removes finite repeat and reopens'], {
    cwd: new URL('../../../', import.meta.url),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  assert.equal(code, 0, output)
})
