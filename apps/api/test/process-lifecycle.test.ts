import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { it } from 'vitest'

import { runCommand, runJsonlProcess, type JsonlProcessOptions } from '../src/modules/harnesses/process.js'

function running(pid: number | undefined): boolean {
  if (!pid) return false
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      // A reaped-or-zombie descendant is no longer executing tool work.
      return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] ?? '')
    }
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH' || code === 'ENOENT') return false
    throw error
  }
}

const options: Omit<JsonlProcessOptions, 'args'> = {
  binary: process.execPath,
  cwd: process.cwd(),
  signal: new AbortController().signal,
  onSpawn: () => undefined,
  onEvent: async () => undefined,
}

for (const stream of ['stdout', 'stderr']) {
  it(`contains ${stream} callback failures and terminates the still-live child`, async () => {
    let pid: number | undefined
    const controller = new AbortController()
    const started = Date.now()
    try {
      await assert.rejects(runJsonlProcess({
        ...options,
        signal: controller.signal,
        args: ['-e', `process.${stream}.write('ready\\n');setInterval(()=>{},1000)`],
        onSpawn: (child) => { pid = child.pid },
        onEvent: async () => { throw new Error('database unavailable') },
      }), /database unavailable/)
      assert.equal(running(pid), false)
      assert.ok(Date.now() - started < 3_000)
      controller.abort() // Cleanup must already have happened before rejection.
    } finally {
      controller.abort()
      if (pid && running(pid)) process.kill(pid, 'SIGKILL')
    }
  })
}

it('preserves ordered structured and malformed stdout', async () => {
  const types: string[] = []
  const result = await runJsonlProcess({
    ...options,
    args: ['-e', 'console.log(JSON.stringify({type:"ready"}));console.log("plain")'],
    onEvent: async (event) => { types.push(event.type) },
  })
  assert.equal(result.exitCode, 0)
  assert.deepEqual(types, ['ready', 'unparsed_stdout'])
})

it('cancels a descendant that inherits pipes and ignores SIGTERM within a bounded period', async () => {
  const controller = new AbortController()
  let child: number | undefined
  let descendant: number | undefined
  const started = Date.now()
  try {
    await runJsonlProcess({
      ...options,
      signal: controller.signal,
      args: ['-e', `
        const {spawn}=require('node:child_process');
        spawn(process.execPath,['-e',
          'process.on("SIGTERM",()=>{});console.log(JSON.stringify({type:"child",pid:process.pid}));setInterval(()=>{},1000)'
        ],{stdio:'inherit'});
        setInterval(()=>{},1000);
      `],
      onSpawn: (process) => { child = process.pid },
      onEvent: async (event) => {
        descendant = Number(event.payload.pid)
        controller.abort()
      },
    })
    await delay(50)
    assert.equal(running(child), false)
    assert.equal(running(descendant), false)
    assert.ok(Date.now() - started < 3_000)
  } finally {
    controller.abort()
    for (const pid of [child, descendant]) if (pid && running(pid)) process.kill(pid, 'SIGKILL')
  }
})

it('escalates qualification cancellation when SIGTERM is ignored', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'graphql-process-'))
  const ready = join(directory, 'ready')
  const controller = new AbortController()
  let pid: number | undefined
  const task = runCommand(process.execPath, ['-e', `
    process.on('SIGTERM',()=>{});
    require('fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));
    setInterval(()=>{},1000);
  `], process.cwd(), controller.signal)
  void task.catch(() => undefined)
  try {
    const deadline = Date.now() + 2_000
    while (!existsSync(ready) && Date.now() < deadline) await delay(10)
    assert.equal(existsSync(ready), true)
    pid = Number(readFileSync(ready, 'utf8'))
    const started = Date.now()
    controller.abort()
    await assert.rejects(task, { name: 'AbortError' })
    assert.equal(running(pid), false)
    assert.ok(Date.now() - started < 3_000)
  } finally {
    controller.abort()
    await task.catch(() => undefined)
    if (pid && running(pid)) process.kill(pid, 'SIGKILL')
    rmSync(directory, { recursive: true, force: true })
  }
})

it('cleans a lingering descendant even when the root exits normally', async () => {
  let descendant: number | undefined
  try {
    await runJsonlProcess({
      ...options,
      args: ['-e', `
        const {spawn}=require('node:child_process');
        const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
        console.log(JSON.stringify({type:'child',pid:child.pid}));
        setTimeout(()=>process.exit(0),100);
      `],
      onEvent: async (event) => { descendant = Number(event.payload.pid) },
    })
    await delay(50)
    assert.equal(running(descendant), false)
  } finally {
    if (descendant && running(descendant)) process.kill(descendant, 'SIGKILL')
  }
})

it('streams 300 KB through stdin without using a large argument', async () => {
  const text = 'a'.repeat(300_000)
  let count: unknown
  const result = await runJsonlProcess({
    ...options,
    stdin: text,
    args: ['-e', `
      let size=0;
      process.stdin.on('data',chunk=>size+=chunk.length);
      process.stdin.on('end',()=>console.log(JSON.stringify({type:'input',size})));
    `],
    onEvent: async (event) => { count = event.payload.size },
  })
  assert.equal(result.exitCode, 0)
  assert.equal(count, text.length)
})

it('observes asynchronous spawn errors immediately', async () => {
  await assert.rejects(runJsonlProcess({ ...options, binary: '/missing/graphql-binary', args: [] }))
})

it('cleans up when process tracking itself throws', async () => {
  let pid: number | undefined
  await assert.rejects(runJsonlProcess({
    ...options,
    args: ['-e', 'setInterval(()=>{},1000)'],
    onSpawn: (child) => { pid = child.pid; throw new Error('tracking failed') },
  }), /tracking failed/)
  assert.equal(running(pid), false)
})
