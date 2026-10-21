import { basename, isAbsolute, win32 } from 'node:path'
import type { SyncedMcpServer } from '@foreman-code/contracts/computer-maintenance'
import type { MaintenancePorts } from './maintenancePorts.js'

function localPath(value: string): string | undefined {
  const argument = value.startsWith('-') && value.includes('=') ? value.slice(value.indexOf('=') + 1) : value
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(argument)) return undefined
  if (isAbsolute(argument) || win32.isAbsolute(argument)
    || argument.startsWith('~') || argument.startsWith('./') || argument.startsWith('../')) return argument
  return undefined
}

function scriptOperand(command: string, args: readonly string[]): string | undefined {
  const interpreter = basename(command.replaceAll('\\', '/')).replace(/\.exe$/iu, '')
  const node = /^(?:node|nodejs)$/iu.test(interpreter)
  const python = /^python(?:\d+(?:\.\d+)*)?$/iu.test(interpreter)
  const shell = /^(?:ba|z|da|k)?sh$/iu.test(interpreter)
  const rubyOrPerl = /^(?:ruby|perl)$/iu.test(interpreter)
  if (!node && !python && !shell && !rubyOrPerl) return undefined
  const valueOptions = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader',
    '--conditions', '--title', '--env-file', '--env-file-if-exists', '-C', '-W', '-X', '-I'])
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!
    if (argument === '-') return undefined
    if (argument === '--') return args[index + 1]
    if (node && (/^-(?:e|p)(?:[^-]|$)/u.test(argument) || ['--eval', '--print'].includes(argument.split('=')[0]!))) {
      return undefined
    }
    if (python && /^-[cm]/u.test(argument)) return undefined
    if (shell && /^-[^-]*[cs]/u.test(argument)) return undefined
    if (rubyOrPerl && /^-e/u.test(argument)) return undefined
    if (valueOptions.has(argument)) {
      index++
      continue
    }
    if (!argument.startsWith('-')) return argument
  }
  return undefined
}

/** Relative paths have no destination working directory in a synced definition. */
export async function assertStdioAvailable(server: SyncedMcpServer, ports: MaintenancePorts): Promise<void> {
  if (server.transport !== 'stdio') return
  const commandPath = localPath(server.command) ?? (/[/\\]/u.test(server.command) ? server.command : undefined)
  const paths = [commandPath, ...server.args.map(localPath), scriptOperand(server.command, server.args)]
    .filter(path => path !== undefined)
  for (const path of paths) {
    if (!isAbsolute(path) || !await ports.exists(path)) {
      throw new Error(`MCP server ${server.name} is unavailable on this computer: ${path} is missing or unresolved. `
        + 'Install the local tool or resolve its path, then retry sync.')
    }
  }
  if (!await ports.find(server.command)) {
    throw new Error(`MCP server ${server.name} is unavailable on this computer: ${server.command} is not installed. `
      + 'Install the executable, then retry sync.')
  }
}
