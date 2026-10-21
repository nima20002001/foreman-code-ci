import { DomainError } from '../errors.js'

export function executableUnavailable(name: string, path: string, home: string, reason: string): DomainError {
  const displayPath = path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path
  return new DomainError('COMPUTER_EXECUTABLE_UNAVAILABLE',
    `The ${name} executable at ${displayPath} is unavailable: ${reason}.`, 409)
}
