import { lstat, readFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { DomainError } from '../errors.js'
import type { HostCiPorts } from './runner.js'

interface CircleConfig { token?: string; host?: string }
const CLOUD_HOST = 'https://circleci.com'

async function readConfig(path: string): Promise<CircleConfig | null> {
  try {
    const config = parse(await readFile(path, 'utf8')) as CircleConfig | null
    if (config !== null && (typeof config !== 'object' || Array.isArray(config)
      || config.token !== undefined && typeof config.token !== 'string'
      || config.host !== undefined && typeof config.host !== 'string')) {
      throw new Error('Invalid credential configuration')
    }
    return config
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw circleCredentialError()
  }
}

export async function configuredCircleToken(ports: HostCiPorts,
  environment: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const environmentToken = environment.CIRCLE_TOKEN || environment.CIRCLE_CLI_TOKEN
  if (environmentToken) return environmentToken
  const directory = environment.XDG_CONFIG_HOME || join(homedir(), '.config')
  const config = await readConfig(join(directory, 'circleci', 'config.yml'))
  const host = environment.CIRCLE_HOST || config?.host || CLOUD_HOST
  // Server credentials must not be sent to the cloud REST endpoint.
  if (host !== CLOUD_HOST) return null
  if (process.platform === 'linux') {
    try {
      // CircleCI CLI v1 uses these Secret Service attributes and prefers the keyring over YAML.
      // https://github.com/CircleCI-Public/circleci-cli/blob/b60dc4c63b65/internal/config/config.go
      const result = await ports.run('secret-tool', ['lookup', 'service', `com.circleci.cli:${host}`,
        'username', userInfo().username], { timeoutMs: 15_000 })
      if (result.code === 0 && result.stdout.trim()) return result.stdout.trim()
    } catch {
      // ignore: an unavailable keyring uses file credentials or the visible CLI transport status.
    }
  }
  if (config?.token?.trim()) return config.token.trim()
  const legacy = await readConfig(join(homedir(), '.circleci', 'cli.yml'))
  return legacy?.token?.trim() || null
}

export function circleCredentialError() {
  return new DomainError('CI_CLOUD_CREDENTIALS_UNAVAILABLE', 'CircleCI credential configuration could not be read.', 503)
}

/** Managed profiles are the only credential source for additional logins. No keyring lookup occurs here. */
export async function circleProfileToken(xdgHome: string): Promise<string | null> {
  const directory = join(xdgHome, 'circleci')
  const path = join(directory, 'config.yml')
  try {
    for (const [entry, isDirectory] of [[xdgHome, true], [directory, true], [path, false]] as const) {
      const info = await lstat(entry)
      if (info.isSymbolicLink() || (isDirectory ? !info.isDirectory() : !info.isFile())
        || process.platform !== 'win32' && (info.mode & 0o777) !== (isDirectory ? 0o700 : 0o600)) {
        throw circleCredentialError()
      }
    }
    const config = await readConfig(path)
    if (config?.host && config.host !== CLOUD_HOST) throw circleCredentialError()
    return config?.token?.trim() || null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw circleCredentialError()
  }
}
