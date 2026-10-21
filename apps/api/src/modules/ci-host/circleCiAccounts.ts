import { componentLogger } from '../diagnostics/logger.js'
import type { CloudAccount } from './cloudProviders.js'
import type { HostCiPorts } from './runner.js'
import type { CircleAccountContext, CircleAccountRegistry } from './circleAccounts.js'

const log = componentLogger('jobs')
const REFRESH_MS = 10 * 60_000

/** Further CircleCI orgs become CI capacity without configuration: each GitHub organization Main's GitHub login belongs
 * to that has a CircleCI project named like a workspace CI mirror. Orgs are only added; a run started on one must stay
 * readable, so orgs with unfinished runs come back after a restart, and an org that loses its project refuses new
 * starts. */
export class CircleCiAccounts {
  private readonly accounts = new Map<string, CloudAccount>()
  private refreshing: Promise<void> | undefined
  private refreshedAt = Number.NEGATIVE_INFINITY

  constructor(private readonly ports: HostCiPorts, private readonly mirrors: () => Promise<string[]>,
    private readonly added: (account: CloudAccount) => unknown,
    private readonly options: {
      runningOwners?: (() => Promise<string[]>) | undefined
      runningOrganizations?: (() => Promise<{ owner: string; circleAccountId: string }[]>) | undefined
      registry?: CircleAccountRegistry | undefined
      context?: ((id: string) => Promise<Pick<CircleAccountContext, 'ports'>>) | undefined
      now?: () => number
      explicitPrimary?: boolean | undefined
    } = {}) {}

  private now() { return (this.options.now ?? Date.now)() }

  invalidate() { this.refreshedAt = Number.NEGATIVE_INFINITY }

  private key(owner: string, id = 'default') { return JSON.stringify([id, owner.toLowerCase()]) }

  /** Starts a discovery pass unless one ran in the last ten minutes; failures keep the known orgs. */
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing
    if (this.now() - this.refreshedAt < REFRESH_MS) return Promise.resolve()
    this.refreshing = this.discover().catch(error => {
      log.warn({ operation: 'discover CircleCI orgs', err: error }, 'CircleCI org discovery failed; known orgs stay')
    }).finally(() => {
      this.refreshedAt = this.now()
      this.refreshing = undefined
    })
    return this.refreshing
  }

  private async discover() {
    const registry = await this.options.registry?.list()
    for (const org of await this.options.runningOrganizations?.() ?? []) {
      if (!this.accounts.has(this.key(org.owner, org.circleAccountId))) {
        const role = registry?.find(account => account.id === org.circleAccountId)?.role
          ?? (org.circleAccountId === 'default' ? 'primary' : 'standby')
        await this.add({ ...org, role, mirrorNames: new Set() })
      }
    }
    for (const owner of await this.options.runningOwners?.() ?? []) {
      if (!this.accounts.has(this.key(owner))) await this.add({ owner, mirrorNames: new Set() })
    }
    const mirrors = await this.mirrors()
    if (!mirrors.length) return
    if (registry?.some(account => account.organizations.length > 0)) {
      await this.discoverConfigured(registry, mirrors)
      if (!registry.some(account => account.id === 'default' && account.organizations.length === 0)) return
    }
    const assignedElsewhere = new Set(registry?.filter(account => account.id !== 'default')
      .flatMap(account => account.organizations.map(owner => owner.toLowerCase())) ?? [])
    const primaryOwners = new Set(mirrors.map(mirror => mirror.slice(0, mirror.indexOf('/')).toLowerCase())
      .filter(owner => !assignedElsewhere.has(owner)))
    const names = [...new Set(mirrors.map(mirror => mirror.slice(mirror.indexOf('/') + 1)))]
    const owners = (await this.command('gh', ['api', 'user/memberships/orgs', '--paginate',
      '--jq', '.[] | select(.state == "active") | .organization.login'])).split('\n').map(line => line.trim())
      .filter(owner => owner && !primaryOwners.has(owner.toLowerCase()) && !assignedElsewhere.has(owner.toLowerCase()))
    if (this.options.explicitPrimary) owners.unshift(...primaryOwners)
    for (const owner of owners) {
      const found = new Set<string>()
      try {
        const ports = this.options.context ? (await this.options.context('default')).ports : this.ports
        for (const name of names) if (await this.followed(owner, name, ports)) found.add(name)
      } catch (error) {
        log.warn({ operation: 'discover CircleCI org', owner, err: error }, 'CircleCI org lookup failed; its known state stays')
        continue
      }
      const known = this.accounts.get(this.key(owner))
      if (known) {
        if (known.registered === false) known.registered = true
        known.mirrorNames.clear()
        for (const name of found) known.mirrorNames.add(name)
      } else if (found.size) await this.add({ owner, circleAccountId: 'default', role: 'primary', mirrorNames: found })
    }
  }

  private async add(account: CloudAccount) {
    await this.added(account)
    this.accounts.set(this.key(account.owner, account.circleAccountId), account)
    log.info({ owner: account.owner, mirrors: [...account.mirrorNames] }, 'CircleCI org added as CI capacity')
  }

  private async discoverConfigured(registry: Awaited<ReturnType<CircleAccountRegistry['list']>>, mirrors: string[]) {
    const bindings = new Set<string>()
    const owners = new Set<string>()
    for (const account of registry) {
      for (const owner of account.organizations) {
        const normalized = owner.toLowerCase()
        if (owners.has(normalized)) continue
        owners.add(normalized)
        const key = this.key(owner, account.id)
        bindings.add(key)
        let known = this.accounts.get(key)
        if (!known) {
          known = { owner, circleAccountId: account.id, role: account.role, registered: true, mirrorNames: new Set() }
          await this.add(known)
        }
        known.registered = true
        try {
          const ports = this.options.context ? (await this.options.context(account.id)).ports : this.ports
          if (account.id !== 'default' && !this.options.context) throw new Error('CircleCI account context is unavailable.')
          const names = [...new Set(mirrors.map(mirror => mirror.slice(mirror.indexOf('/') + 1)))]
          const found = new Set<string>()
          for (const name of names) if (await this.followed(owner, name, ports)) found.add(name)
          known.mirrorNames.clear()
          for (const name of found) known.mirrorNames.add(name)
        } catch {
          log.warn({ operation: 'discover CircleCI org', circleAccountId: account.id, owner },
            'CircleCI project lookup failed; its known projects stay')
        }
      }
    }
    const implicitPrimary = registry.some(account => account.id === 'default' && account.organizations.length === 0)
    for (const [key, account] of this.accounts) {
      if (implicitPrimary && (account.circleAccountId ?? 'default') === 'default'
        && !owners.has(account.owner.toLowerCase())) continue
      if (!bindings.has(key)) { account.registered = false; account.mirrorNames.clear() }
    }
  }

  private async followed(owner: string, name: string, ports = this.ports) {
    const result = await ports.run('circleci', ['project', 'get', '--project', `gh/${owner}/${name}`, '--json'],
      { timeoutMs: 30_000 })
    if (result.code === 0) return true
    if (/\bproject\.not_found\b|Project not found/.test(result.stderr + result.stdout)) return false
    throw new Error(`CircleCI project lookup for gh/${owner}/${name} failed.`)
  }

  private async command(file: string, args: string[]) {
    const result = await this.ports.run(file, args, { timeoutMs: 30_000 })
    if (result.code !== 0) throw new Error(`${file} ${args[0]} failed: ${result.stderr.trim().slice(0, 300)}`)
    return result.stdout
  }
}
