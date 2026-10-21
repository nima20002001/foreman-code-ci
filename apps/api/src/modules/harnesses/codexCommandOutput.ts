import { HarnessExecutionError } from './errors.js'
import { object } from './codexStdioTransport.js'

interface CommandIdentity {
  threadId: string
  turnId: string
  itemId: string
}

export function recordedCodexCommandOutput(entries: unknown,
  expected: { turnId: string; itemId: string; command: unknown }): string | undefined {
  if (!Array.isArray(entries)) return undefined
  const matching = entries.filter(entry => {
    const row = object(entry)
    const item = object(row.item)
    return row.turnId === expected.turnId && item.id === expected.itemId && item.type === 'commandExecution'
  })
  if (matching.length !== 1) return undefined
  const item = object(object(matching[0]).item)
  if (item.command !== expected.command || item.status !== 'completed' || item.exitCode !== 0
    || typeof item.aggregatedOutput !== 'string') return undefined
  return item.aggregatedOutput
}

/** One qualified transport's command stdout, separated by native thread, turn and item. */
export class CodexCommandOutput {
  private readonly commands = new Map<string, string>()
  private readonly completed = new Map<string, string>()

  complete(input: CommandIdentity & { output: unknown }): void {
    const key = JSON.stringify([input.threadId, input.turnId, input.itemId])
    let output: string
    if (typeof input.output === 'string') output = input.output
    else if (Array.isArray(input.output) && input.output.every(part =>
      part?.type === 'input_text' && typeof part.text === 'string')) {
      output = input.output.map(part => part.text).join('\n')
    } else return
    if (Buffer.byteLength(output) > 64 * 1024 || !this.completed.has(key) && this.completed.size >= 16) {
      throw new HarnessExecutionError('CODEX_COMMAND_OUTPUT_LIMIT', 'Native diagnostic command output exceeds its bound.')
    }
    const previous = this.completed.get(key)
    if (previous !== undefined && previous !== output) {
      throw new HarnessExecutionError('CODEX_COMMAND_OUTPUT_CONFLICT', 'The original command result changed.')
    }
    this.completed.set(key, output)
  }

  append(input: CommandIdentity & { delta: string }): void {
    const key = JSON.stringify([input.threadId, input.turnId, input.itemId])
    const previous = this.commands.get(key) ?? ''
    const output = previous + input.delta
    if (Buffer.byteLength(output) > 64 * 1024 || !this.commands.has(key) && this.commands.size >= 16) {
      throw new HarnessExecutionError('CODEX_COMMAND_OUTPUT_LIMIT', 'Native diagnostic command output exceeds its bound.')
    }
    this.commands.set(key, output)
  }

  read(input: CommandIdentity, aggregate: unknown): string | undefined {
    if (typeof aggregate === 'string') return aggregate
    const key = JSON.stringify([input.threadId, input.turnId, input.itemId])
    return this.completed.get(key) ?? this.commands.get(key)
  }
}
