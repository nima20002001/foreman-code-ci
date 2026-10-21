import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { utimes, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { expect, vi } from 'vitest'

/** Git arguments that replace a fetch with a writer which, on request, creates `files` (relative to the common
 * directory, with byte sizes) and closes each one, as Git closes a lock before committing it. The writer runs inside
 * the fetch's process group, so cancelling the fetch kills it like a real transfer. */
export async function interruptedFetchWriter(root: string, common: string, files: Record<string, number>) {
  const helper = join(root, `interrupted-fetch-${randomUUID()}.mjs`)
  const address = `foreman-interrupted-fetch-${randomUUID()}`
  await writeFile(helper, `
    import { connect } from 'node:net';
    import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
    import { dirname } from 'node:path';
    const [common, address, files] = process.argv.slice(2);
    const stat = readFileSync('/proc/self/stat', 'utf8');
    const group = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2];
    const socket = connect('\\0' + address);
    socket.on('connect', () => socket.write(group + '\\n'));
    socket.on('data', command => {
      if (String(command).trim() === 'die') process.kill(0, 'SIGKILL');
      for (const [name, size] of Object.entries(JSON.parse(files))) {
        mkdirSync(dirname(common + '/' + name), { recursive: true });
        writeFileSync(common + '/' + name, Buffer.alloc(size, 1), { flag: 'wx' });
      }
      socket.write('written\\n');
    });
  `)
  const server = createServer()
  const connected = once(server, 'connection')
  server.listen('\0' + address)
  await once(server, 'listening')
  let socket: Socket | undefined
  return {
    args: ['-c', `alias.interrupted=!'${process.execPath}' '${helper}'`, 'interrupted', common, address,
      JSON.stringify(files)],
    async started() {
      ;[socket] = await connected as [Socket]
      const group = Number(String((await once(socket, 'data'))[0]).trim())
      return {
        async write() {
          const written = once(socket!, 'data')
          socket!.write('write\n')
          expect(String((await written)[0]).trim()).toBe('written')
        },
        /** Kill the whole transfer group, as a lost API's later cancellation or crash would. */
        async die() {
          socket!.write('die\n')
          await vi.waitFor(() => expect(() => process.kill(-group, 0)).toThrow(), { timeout: 10_000 })
        },
      }
    },
    close() {
      socket?.destroy()
      server.close()
    },
  }
}

/** Back-date `names` (relative to the common directory) far past fetch recovery's staleness bound, as if their writer
 * had died long ago. */
export async function makeStale(common: string, names: string[]) {
  const past = new Date(Date.now() - 60 * 60_000)
  for (const name of names) await utimes(join(common, name), past, past)
}

/** A separate API process that starts a cache fetch through `writerArgs`; the caller kills it to lose its memory. */
export async function fetchingApi(root: string, cache: string, clone: string, writerArgs: string[],
  environment: NodeJS.ProcessEnv): Promise<ChildProcess> {
  const launcher = join(root, `fetch-api-${randomUUID()}.mjs`)
  const sources = new URL('../../src/modules/sources/', import.meta.url)
  await writeFile(launcher, `
    import { runGitWithCacheStorage } from ${JSON.stringify(new URL('gitCacheStorage.ts', sources).href)};
    import { runGitProcess } from ${JSON.stringify(new URL('gitProcess.ts', sources).href)};
    const [cache, clone, writer] = process.argv.slice(2);
    await runGitWithCacheStorage(cache, ['fetch', 'origin'], { cwd: clone, signal: new AbortController().signal },
      (args, options) => runGitProcess(args.includes('fetch') ? JSON.parse(writer) : args, options, process.env));
  `)
  return spawn(process.execPath, ['--import', 'tsx', launcher, cache, clone, JSON.stringify(writerArgs)],
    { env: environment, stdio: ['ignore', 'ignore', 'inherit'] })
}
