import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CIRCLE_ACCOUNT_ID, CircleAccountIdSchema, type CircleAccount, type CircleAccountRead } from '@foreman-code/contracts/management'
import { CloudHttp } from './cloudHttp.js'
import type { HostCiPorts } from './runner.js'
import { circleCredentialError, circleProfileToken, configuredCircleToken } from './circleCredentials.js'
import { DomainError } from '../errors.js'
import { invalidateProviderPoll } from './providerPoll.js'

/** Internal contexts carry credentials through ports and HTTP, never through public readback. */
export interface CircleAccountContext extends CircleAccount {
  ports: HostCiPorts
  http: CloudHttp
  tokenConfigured(): Promise<boolean>
  invalidate(): void
}
export interface CircleAccountRegistry {
  list(): Promise<CircleAccount[]>
}
export interface CircleAccountStatusReader {
  read(account: CircleAccount): Promise<Pick<CircleAccountRead, 'tokenConfigured' | 'ready' | 'reasons' | 'orgs'>>
}
/** Called only after a committed registry change; consumers discard only this login's cached state. */
export type CircleAccountRegistryChanged = (id: string) => void | Promise<void>

interface CircleAccountDirectoryOptions {
  configRoot?: string
  environment?: NodeJS.ProcessEnv
  fetch?: typeof fetch
}

export class CircleAccountDirectory implements CircleAccountStatusReader {
  private readonly contexts = new Map<string, CircleAccountContext>()
  private readonly environment: NodeJS.ProcessEnv
  private readonly configRoot: string

  constructor(private readonly basePorts: HostCiPorts, private readonly registry: CircleAccountRegistry,
    private readonly options: CircleAccountDirectoryOptions = {}) {
    this.environment = { ...(options.environment ?? process.env) }
    this.configRoot = options.configRoot ?? this.environment.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  }

  async accounts(): Promise<CircleAccountContext[]> {
    return (await this.registry.list()).map(account => this.accountContext(account))
  }

  async context(id: string): Promise<CircleAccountContext | null> {
    CircleAccountIdSchema.parse(id)
    return (await this.accounts()).find(account => account.id === id) ?? null
  }

  invalidate(id: string): void {
    this.contexts.get(id)?.invalidate()
  }

  async read(account: CircleAccount): Promise<Pick<CircleAccountRead, 'tokenConfigured' | 'ready' | 'reasons' | 'orgs'>> {
    const context = this.accountContext(account)
    let tokenConfigured = false
    let reason = 'Local human setup must provision this account’s API token.'
    try {
      tokenConfigured = await context.tokenConfigured()
      if (tokenConfigured) reason = 'Authentication has not been checked.'
    } catch {
      // Profile errors are a setup status, never a raw filesystem/provider error in public readback.
      reason = 'CircleCI credential configuration could not be read.'
    }
    return { tokenConfigured, ready: false, reasons: [reason], orgs: account.organizations.map(owner => ({
      account: owner, circleAccountId: account.id, ready: false, running: 0,
      schedulingRole: account.role === 'standby' ? 'standby' : 'active',
      schedulingReason: reason, credits: null, creditsUnavailable: 'Usage has not been read.',
    })) }
  }

  private accountContext(account: CircleAccount): CircleAccountContext {
    const cached = this.contexts.get(account.id)
    if (cached) return Object.assign(cached, account)
    const xdgHome = join(this.configRoot, 'foreman-code', 'circleci-accounts', account.id)
    const circleToken = async () => {
      const token = await circleProfileToken(xdgHome)
      if (token !== null || account.id !== DEFAULT_CIRCLE_ACCOUNT_ID) return token
      return configuredCircleToken(this.basePorts, this.environment)
    }
    const http = new CloudHttp(this.basePorts, 'circleci', {
      ...this.options, circleAccountId: account.id, circleToken,
    })
    const ports: HostCiPorts = {
      ...this.basePorts,
      run: async (file, args, options) => {
        if (file !== 'circleci') return this.basePorts.run(file, args, options)
        return http.withCredential(async token => {
          if (!token) throw circleCredentialError()
          const env = { ...this.environment, ...options?.env, XDG_CONFIG_HOME: xdgHome,
            CIRCLE_TOKEN: token, CIRCLE_CLI_TOKEN: token, CIRCLE_HOST: 'https://circleci.com' }
          try {
            const result = await this.basePorts.run(file, args, { ...options, env })
            return { ...result, stdout: result.stdout.split(token).join('[redacted]'),
              stderr: result.stderr.split(token).join('[redacted]') }
          } catch {
            throw new DomainError('CI_CLOUD_FAILED', 'CircleCI command failed.', 502)
          }
        })
      },
    }
    const context: CircleAccountContext = { ...account, ports, http,
      tokenConfigured: () => http.withCredential(async token => token !== null),
      invalidate: () => {
        http.invalidate()
        invalidateProviderPoll(ports)
      },
    }
    this.contexts.set(account.id, context)
    return context
  }
}
