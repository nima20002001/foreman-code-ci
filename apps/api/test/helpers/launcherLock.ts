import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function heldLauncher() {
  const directory = await mkdtemp(join(tmpdir(), 'launcher-cancel-'))
  const launcher = join(directory, 'launcher.mjs')
  const source = join(directory, 'source.mjs')
  await writeFile(launcher, 'original launcher')
  await writeFile(source, 'replacement launcher')
  const owner = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    const cp = require('node:child_process');
    const fd = fs.openSync(process.argv[1], 'r');
    cp.execFileSync('/usr/bin/flock', ['--exclusive', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] });
    process.stdout.write('locked');
    setInterval(() => {}, 1000);
  `, directory], { stdio: ['ignore', 'pipe', 'pipe'] })
  await once(owner.stdout!, 'data')
  const release = async () => {
    if (owner.exitCode !== null || owner.signalCode !== null) return
    const closed = once(owner, 'close')
    owner.kill('SIGKILL')
    await closed
  }
  return {
    launcher,
    source: pathToFileURL(source),
    release,
    close: async () => {
      await release()
      await rm(directory, { recursive: true, force: true })
    },
  }
}
