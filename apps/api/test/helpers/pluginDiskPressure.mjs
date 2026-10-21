import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { systemMaintenancePorts } from '../../src/modules/computers/maintenance.js'

const home = process.argv[2]
const ports = systemMaintenancePorts({ HOME: home, XDG_CACHE_HOME: join(home, 'cache') })
const plugin = join(home, '.codex', 'plugins', 'cache', 'official', 'notes')
await mkdir(join(plugin, '1.0.0'), { recursive: true })
await writeFile(join(plugin, '1.0.0', 'payload.txt'), 'working plugin')
const backup = await ports.backupPlugin('codex', 'notes@official')
await rm(plugin, { recursive: true })
await mkdir(join(plugin, '2.0.0'), { recursive: true })
await writeFile(join(plugin, '2.0.0', 'payload.txt'), 'failed activation')
// Limit only this disposable child: copying file contents must now fail, while renames still work.
await promisify(execFile)('prlimit', ['--pid', String(process.pid), '--fsize=0:0'])
await backup.restore()
if (await ports.readText(join(plugin, '1.0.0', 'payload.txt')) !== 'working plugin') {
  throw new Error('The working plugin was not restored')
}
await backup.discard()
process.stdout.write('restored')
