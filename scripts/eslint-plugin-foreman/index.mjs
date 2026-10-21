// Local lint rules for patterns earlier changes kept producing. Each package config ends with
// `...foremanLint(import.meta.dirname)`. Files listed in scripts/lint-allowlist.json predate a rule and are exempt
// from it; that list may only shrink (scripts/lint-baseline.mjs prunes it).
import { resolveLintAllowlist } from '../lint-allowlist.mjs'
import { readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const name = node => node?.type === 'Identifier' ? node.name
  : node?.type === 'MemberExpression' && !node.computed ? node.property.name
    : node?.type === 'ChainExpression' ? name(node.expression) : undefined

function literalText(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node?.type === 'TemplateLiteral') return node.quasis[0].value.cooked ?? ''
  return undefined
}

function numberValue(node) {
  if (node?.type === 'Literal' && typeof node.value === 'number') return node.value
  if (node?.type === 'BinaryExpression' && node.operator === '*') {
    const left = numberValue(node.left), right = numberValue(node.right)
    return left === undefined || right === undefined ? undefined : left * right
  }
  return undefined
}

const ignoreComment = (sourceCode, node) => sourceCode.getCommentsInside(node)
  .some(comment => comment.value.trim().replace(/^\*\s*/, '').startsWith('ignore:'))

const rule = (description, message, create) => ({
  meta: { type: 'problem', docs: { description }, schema: [], messages: { problem: message } },
  create,
})

const sourcePath = /\.(?:[cm]?ts|tsx|mjs)$/
const sqlName = /(?:sql|statements?|quer(?:y|ies))$/i
const textMatchers = new Set(['toBe', 'toEqual', 'toStrictEqual', 'toContain', 'toMatch'])

const rules = {
  'no-source-text-tests': rule('Tests assert behavior, not the text of repository source files or SQL.',
    'Assert behavior through a public interface (rendered UI, HTTP/MCP response, function result, persisted data), not source or SQL text.',
    context => ({
      ImportDeclaration(node) {
        if (/[?&]raw$/.test(node.source.value)) context.report({ node, messageId: 'problem' })
      },
      CallExpression(node) {
        const callee = name(node.callee)
        if ((callee === 'readFile' || callee === 'readFileSync') && node.arguments[0]) {
          const strings = []
          const collect = value => {
            if (!value || typeof value !== 'object') return
            if (Array.isArray(value)) return value.forEach(collect)
            if (value.type === 'Literal' && typeof value.value === 'string') strings.push(value.value)
            else if (value.type === 'TemplateElement') strings.push(value.value.cooked ?? '')
            for (const [key, child] of Object.entries(value)) if (key !== 'parent' && key !== 'loc' && key !== 'range') collect(child)
          }
          collect(node.arguments[0])
          if (strings.some(text => sourcePath.test(text.trim()))) context.report({ node, messageId: 'problem' })
          return
        }
        if (node.callee.type !== 'MemberExpression' || !textMatchers.has(name(node.callee))) return
        let subject = node.callee.object
        if (name(subject) === 'not' && subject.type === 'MemberExpression') subject = subject.object
        if (subject.type !== 'CallExpression' || name(subject.callee) !== 'expect') return
        const actual = subject.arguments[0]
        const actualName = actual && ['Identifier', 'MemberExpression', 'ChainExpression'].includes(actual.type) ? name(actual) : undefined
        if (actualName && sqlName.test(actualName)) context.report({ node, messageId: 'problem' })
      },
    })),

  'no-local-canonical-json': rule('Canonical JSON comes from the one shared module.',
    'Use the shared canonical JSON module instead of a local canonical/stable JSON helper.',
    context => {
      if (context.filename.includes('canonicalJson')) return {}
      const pattern = /^(?:canonical|stable).*(?:json|stringify|serialize)/i
      const check = (node, id) => { if (id?.type === 'Identifier' && pattern.test(id.name)) context.report({ node, messageId: 'problem' }) }
      return {
        FunctionDeclaration: node => check(node, node.id),
        VariableDeclarator: node => check(node, node.id),
      }
    }),

  'no-raw-transactions': rule('Transactions go through the shared transaction helper.',
    'Use the shared transaction helper instead of sending BEGIN/COMMIT/ROLLBACK yourself.',
    context => ({
      CallExpression(node) {
        if (name(node.callee) !== 'query') return
        const text = literalText(node.arguments[0])
        if (text !== undefined && /^\s*(?:begin|commit|rollback|start\s+transaction)\b/i.test(text)) {
          context.report({ node, messageId: 'problem' })
        }
      },
    })),

  'no-silent-catch': rule('Errors are logged or rethrown, not discarded.',
    'Handle or log the error; if discarding it is right, say why in a comment starting with "ignore:".',
    context => {
      const discards = fn => (fn?.type === 'ArrowFunctionExpression' || fn?.type === 'FunctionExpression')
        && (fn.body.type === 'BlockStatement' ? fn.body.body.length === 0
          : (fn.body.type === 'Identifier' && fn.body.name === 'undefined')
            || (fn.body.type === 'Literal' && fn.body.value === null)
            || (fn.body.type === 'UnaryExpression' && fn.body.operator === 'void' && fn.body.argument.type === 'Literal'))
      return {
        CallExpression(node) {
          if (node.callee.type === 'MemberExpression' && name(node.callee) === 'catch' && discards(node.arguments[0])
            && !ignoreComment(context.sourceCode, node.arguments[0])) context.report({ node, messageId: 'problem' })
        },
        CatchClause(node) {
          if (node.body.body.length === 0 && !ignoreComment(context.sourceCode, node.body)) {
            context.report({ node, messageId: 'problem' })
          }
        },
      }
    }),

  'no-error-rewrap-without-cause': rule('A caught error that is replaced by a new error stays reachable as its cause.',
    'Pass the caught error as `cause` (for example `new XError(message, { cause: error })`), or rethrow it.',
    context => {
      // Only the catch's own body counts; a nested function or catch handles its own errors.
      const thrownNew = (node, found = []) => {
        if (!node || typeof node !== 'object') return found
        if (Array.isArray(node)) { node.forEach(child => thrownNew(child, found)); return found }
        if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ClassBody', 'CatchClause'].includes(node.type)) return found
        if (node.type === 'ThrowStatement' && node.argument?.type === 'NewExpression') found.push(node.argument)
        for (const [key, child] of Object.entries(node)) if (key !== 'parent') thrownNew(child, found)
        return found
      }
      const keepsCause = (created, caught) => created.arguments.some(argument =>
        (argument.type === 'Identifier' && (argument.name === caught || argument.name === 'cause'))
        || (argument.type === 'ArrayExpression' && argument.elements.some(element => element?.type === 'Identifier' && element.name === caught))
        || (argument.type === 'NewExpression' && keepsCause(argument, caught))
        || (argument.type === 'ObjectExpression' && argument.properties.some(property =>
          property.type === 'SpreadElement' || name(property.key) === 'cause')))
      // An unbound `catch {}` discards the error on purpose; a bound one that throws a replacement must keep it.
      const check = (body, param) => {
        if (param?.type !== 'Identifier') return
        const caught = param.name
        for (const created of thrownNew(body)) {
          if (!keepsCause(created, caught) && !ignoreComment(context.sourceCode, created)) {
            context.report({ node: created, messageId: 'problem' })
          }
        }
      }
      return {
        CatchClause(node) { check(node.body, node.param) },
        CallExpression(node) {
          const callback = node.arguments[0]
          if (node.callee.type === 'MemberExpression' && name(node.callee) === 'catch'
            && (callback?.type === 'ArrowFunctionExpression' || callback?.type === 'FunctionExpression')
            && callback.body.type === 'BlockStatement') check(callback.body.body, callback.params[0])
        },
      }
    }),

  'no-legacy-execution-semantics': rule('Only execution semantics 3 is executable.',
    'Execution semantics 1 and 2 are retired; do not branch on them.',
    context => {
      const isField = node => name(node) === 'executionSemanticsVersion'
      const isLegacy = node => node?.type === 'Literal' && (node.value === 1 || node.value === 2)
      return {
        BinaryExpression(node) {
          if (!['==', '===', '!=', '!==', '<', '<=', '>', '>='].includes(node.operator)) return
          if ((isField(node.left) && isLegacy(node.right)) || (isField(node.right) && isLegacy(node.left))) {
            context.report({ node, messageId: 'problem' })
          }
        },
        SwitchCase(node) {
          if (isLegacy(node.test) && isField(node.parent.discriminant)) context.report({ node, messageId: 'problem' })
        },
      }
    }),

  'test-timeout-limit': rule('Unit tests and hooks finish within 30 seconds.',
    'Unit test and hook timeouts stay at or below 30000 ms; move slow work to an integration test or make it faster.',
    context => ({
      CallExpression(node) {
        const callee = node.callee.type === 'MemberExpression' ? node.callee.object : node.callee
        if (!['it', 'test', 'describe', 'beforeEach', 'beforeAll', 'afterEach', 'afterAll'].includes(name(callee))) return
        const timeouts = node.arguments.slice(1).flatMap(argument => argument.type === 'ObjectExpression'
          ? argument.properties.filter(property => property.type === 'Property' && name(property.key) === 'timeout').map(property => property.value)
          : [argument])
        if (timeouts.some(value => (numberValue(value) ?? 0) > 30_000)) context.report({ node, messageId: 'problem' })
      },
    })),
}

export const plugin = { meta: { name: 'eslint-plugin-foreman' }, rules }

const tests = ['**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**', '**/__tests__/**']
const size = { skipBlankLines: true, skipComments: true }

/** Config objects for one package directory: every rule is an error, minus that package's allowlisted files. */
export function foremanLint(directory) {
  const allowlist = resolveLintAllowlist(root, JSON.parse(readFileSync(resolve(root, 'scripts/lint-allowlist.json'), 'utf8')))
  const prefix = `${relative(root, directory)}/`
  const exemptions = process.env.FOREMAN_LINT_BASELINE === '1' ? [] : Object.entries(allowlist.eslint).flatMap(([id, files]) => {
    const local = files.filter(file => file.startsWith(prefix)).map(file => file.slice(prefix.length))
    return local.length ? [{ files: local, rules: { [id]: 'off' } }] : []
  })
  return [
    {
      plugins: { foreman: plugin },
      rules: {
        'foreman/no-local-canonical-json': 'error',
        'foreman/no-raw-transactions': 'error',
        'foreman/no-silent-catch': 'error',
        'foreman/no-legacy-execution-semantics': 'error',
      },
    },
    // The shared transaction helper is the one module that sends BEGIN/COMMIT/ROLLBACK.
    { files: ['src/infrastructure/transaction.ts'], rules: { 'foreman/no-raw-transactions': 'off' } },
    { ignores: tests, rules: { 'max-lines-per-function': ['error', { max: 200, ...size }], 'foreman/no-error-rewrap-without-cause': 'error' } },
    { files: tests, rules: { 'foreman/no-source-text-tests': 'error' } },
    { files: ['src/**/*.test.*'], rules: { 'foreman/test-timeout-limit': 'error' } },
    ...exemptions,
  ]
}
