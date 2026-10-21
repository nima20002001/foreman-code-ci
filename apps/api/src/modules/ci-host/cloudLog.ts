import type { CircleJob, CircleStep } from './cloudCircle.js'

const escape = String.fromCharCode(27)
const bell = String.fromCharCode(7)
const terminalToken = new RegExp(
  String.raw`${escape}\](?:[^${bell}${escape}]|${escape}(?!\\))*(?:${bell}|${escape}\\)`
    + String.raw`|${escape}\[[0-?]*[ -/]*[@-~]|${escape}.|[^${escape}]`,
  'gsu',
)
const cursorSequence = new RegExp(String.raw`^${escape}\[([0-9;]*)([A-Za-z\x60])$`)

/** Replays the cursor redraws used by CI progress output, retaining every completed line. */
export function renderTerminal(input: string): string {
  if (!input.includes(escape) && !/[\r\b\t\v\f]/.test(input)) {
    const lines = input.split('\n').map(line => line.replace(/ +$/, ''))
    while (lines.at(-1) === '') lines.pop()
    return lines.length ? `${lines.join('\n')}\n` : ''
  }
  const rows: string[][] = [[]]
  const completed: string[] = []
  let row = 0
  let column = 0
  const move = () => {
    while (row >= 100) {
      completed.push(rows.shift()!.join('').replace(/ +$/, ''))
      row--
    }
    while (rows.length <= row) rows.push([])
    column = Math.max(0, Math.min(column, Math.max(65536, rows[row]!.length)))
  }
  const tokens = input.match(terminalToken) ?? []
  for (const token of tokens) {
    const sequence = cursorSequence.exec(token)
    if (sequence) {
      const values = sequence[1]!.split(';').map(value => Number(value))
      const distance = values[0] || 1
      switch (sequence[2]) {
        case 'A':
          row = Math.max(0, row - distance)
          break
        case 'B':
        case 'e':
          row = Math.min(99, row + distance)
          break
        case 'C':
        case 'a':
          column += distance
          break
        case 'D':
          column -= distance
          break
        case 'E':
          row = Math.min(99, row + distance)
          column = 0
          break
        case 'F':
          row = Math.max(0, row - distance)
          column = 0
          break
        case 'G':
        case '`':
          column = distance - 1
          break
        case 'd':
          row = Math.min(99, distance - 1)
          break
        case 'H':
        case 'f':
          row = Math.min(99, distance - 1)
          column = (values[1] || 1) - 1
          break
        case 'K': {
          const cells = rows[row]!
          if (values[0] === 2) rows[row] = []
          else if (values[0] === 1) cells.fill(' ', 0, column + 1)
          else cells.splice(column)
          break
        }
        case 'J':
          if (values[0] === 2 || values[0] === 3) {
            rows.splice(0, rows.length, ...Array.from({ length: row + 1 }, () => []))
          } else if (values[0] === 1) {
            for (let index = 0; index < row; index++) rows[index] = []
            rows[row]!.fill(' ', 0, column + 1)
          } else {
            rows[row]!.splice(column)
            rows.splice(row + 1)
          }
          break
        case 'X':
          rows[row]!.fill(' ', column, column + distance)
          break
        case 'S':
          for (let index = 0; index < Math.min(100, distance); index++) {
            completed.push((rows.shift() ?? []).join('').replace(/ +$/, ''))
            rows.push([])
          }
          row = 99
          break
        case 'T':
          rows.unshift(...Array.from({ length: Math.min(100, distance) }, () => []))
          rows.splice(100)
          row = 0
          break
        case 'b': {
          const last = rows[row]?.[column - 1]
          if (last) {
            const cells = rows[row]!
            const repeats = Math.min(65536, distance)
            while (cells.length < column) cells.push(' ')
            for (let index = 0; index < repeats; index++) cells[column++] = last
          }
          break
        }
      }
      move()
      continue
    }
    if (token.startsWith('\x1b')) {
      if (token === '\x1bD' || token === '\x1bE') {
        row++
        if (token === '\x1bE') column = 0
      } else if (token === '\x1bM') {
        if (row > 0) row--
        else {
          rows.unshift([])
          rows.splice(100)
        }
      } else if (token === '\x1bc') {
        rows.splice(0, rows.length, [])
        row = 0
        column = 0
      }
      move()
      continue
    }
    if (token === '\r') column = 0
    else if (token === '\n') {
      row++
      column = 0
    } else if (token === '\v' || token === '\f') row++
    else if (token === '\b') column = Math.max(0, column - 1)
    else if (token === '\t') column += 8 - column % 8
    else if (token.charCodeAt(0) >= 32 && token !== '\x7f') {
      const cells = rows[row]!
      while (cells.length < column) cells.push(' ')
      cells[column++] = token
    }
    move()
  }
  const lines = [...completed, ...rows.map(cells => cells.join('').replace(/ +$/, ''))]
  while (lines.at(-1) === '') lines.pop()
  return lines.length ? `${lines.join('\n')}\n` : ''
}

function duration(step: CircleStep) {
  if (!step.started_at || !step.ended_at) return '-'
  const ms = Math.floor(Date.parse(step.ended_at) - Date.parse(step.started_at))
  if (ms <= 0) return '-'
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m${seconds % 60}s`
  const fraction = Math.floor(ms % 1000 / 100)
  return fraction ? `${seconds}.${fraction}s` : `${seconds}s`
}

function status(step: CircleStep) {
  if (step.phase === 'created') return '⏳ created'
  if (step.phase === 'queued') return '⌛ queued'
  if (step.phase === 'started') return '🔵 running'
  if (step.phase !== 'ended') return step.phase
  const symbols: Record<string, string> = { succeeded: '✅ succeeded', failed: '❌ failed', canceled: '⚪ canceled',
    unauthorized: '🔒 unauthorized', not_run: '🚫 not run', errored: '⚠️ errored',
    infrastructure_fail: '⚠️ infrastructure_fail', timedout: '⚠️ timedout' }
  return symbols[step.outcome ?? ''] ?? step.outcome ?? ''
}

export function circleJobLog(id: string, job: CircleJob, steps: CircleStep[], output: string[]) {
  let text = `# Job Output\n- ID: \`${id}\`\n- Name: ${job.name}\n- Execution: 0\n`
  steps.forEach((step, index) => {
    text += `\n## ${step.num}: ${step.name}\n- Status: ${status(step)}\n- Duration: ${duration(step)}\n`
    if (step.exit_code !== undefined) text += `- Exit Code: ${step.exit_code}\n`
    if (step.command) {
      const lines = step.command.split('\n')
      const command = lines.slice(0, 2).map(line => `\`${line.replaceAll('|', '\\|')}\``).join(' … ')
      text += `- Command: ${command}${lines.length > 2 ? ' …' : ''}\n`
    }
    text += '### Output\n'
    const value = output[index] ?? ''
    if (!value.trim()) {
      text += '\n_(no output)_\n'
      return
    }
    let longest = 2
    for (const match of value.matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
    const fence = '`'.repeat(longest + 1)
    text += `\n${fence}text\n${value}${fence}\n`
  })
  return text
}
