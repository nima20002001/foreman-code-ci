import { expect, it } from 'vitest'
import { runCommand } from '../src/modules/harnesses/process.js'

it('rejects oversized stdout during collection and stops the writer', async () => {
  await expect(runCommand(process.execPath, ['-e', "setInterval(() => process.stdout.write('x'.repeat(8192)), 1)"], process.cwd(),
    AbortSignal.timeout(3_000), {}, { maxOutputBytes: 1024 })).rejects.toThrow(/bounded collection/)
}, 5_000)
it('uses a shared byte budget for stderr and stdout', async () => {
  await expect(runCommand(process.execPath, ['-e', "process.stdout.write('a'.repeat(700)); process.stderr.write('b'.repeat(700))"], process.cwd(),
    AbortSignal.timeout(3_000), {}, { maxOutputBytes: 1024 })).rejects.toThrow(/bounded collection/)
})
it('retains normal small command output', async () => {
  expect(await runCommand(process.execPath, ['-e', "process.stdout.write('ok')"], process.cwd(), undefined, {}, { maxOutputBytes: 1024 }))
    .toMatchObject({ exitCode: 0, stdout: 'ok' })
})
