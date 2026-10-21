/* global process */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)

/** Use the pinned native sandbox, including its real descendant restrictions. */
export async function runNativeShell(command, policy, settings) {
  const write = policy.sandbox.type === 'workspaceWrite'
  const overrides = {
    sandbox_mode: write ? 'workspace-write' : 'read-only',
    'sandbox_workspace_write.writable_roots': policy.sandbox.writableRoots ?? [],
    'sandbox_workspace_write.network_access': policy.sandbox.networkAccess,
    'sandbox_workspace_write.exclude_tmpdir_env_var': policy.sandbox.excludeTmpdirEnvVar ?? true,
    'sandbox_workspace_write.exclude_slash_tmp': policy.sandbox.excludeSlashTmp ?? true,
  }
  const args = [settings.sandboxLauncher]
  for (const [key, value] of Object.entries(overrides)) args.push('-c', `${key}=${JSON.stringify(value)}`)
  args.push('sandbox', '--', '/bin/sh', '-c', command)
  try {
    const result = await execute(process.execPath, args, { cwd: policy.cwd,
      env: { ...process.env, CODEX_HOME: settings.sandboxHome }, timeout: 30000 })
    return { exitCode: 0, output: result.stdout + result.stderr }
  } catch (error) {
    if (typeof error.code !== 'number') throw error
    return { exitCode: error.code, output: error.stdout + error.stderr }
  }
}
