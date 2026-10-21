// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { CODEX_APPROVAL_OPTIONS_FIXTURE, type ApprovalResponseOption } from '@foreman-code/contracts'
import { NativeInteractionResponse } from './NativeInteractionResponse'

const base = CODEX_APPROVAL_OPTIONS_FIXTURE[0]!
const decline = CODEX_APPROVAL_OPTIONS_FIXTURE.find((option) => option.semantic === 'reject')!

it('edits the complete response for composed forms and still validates every required field', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()
  const option: ApprovalResponseOption = { ...base, label: 'Accept', input: { kind: 'form', schema: {
    type: 'object', required: ['name'], properties: { name: { type: 'string' } },
    allOf: [{ required: ['code'], properties: { code: { type: 'string', minLength: 2 } } }],
  } } }
  const { rerender } = render(<NativeInteractionResponse options={[option]} disabled={false} onSelect={onSelect} />)
  const editor = screen.getByRole('textbox', { name: /Form response/ })
  await user.clear(editor)
  await user.click(editor)
  await user.paste('{"name":"Entered"}')
  await user.click(screen.getByRole('button', { name: 'Accept' }))
  expect(screen.getByRole('alert')).toBeVisible()
  expect(onSelect).not.toHaveBeenCalled()
  await user.clear(editor)
  await user.paste('{"name":"Entered","code":"AB"}')
  await user.click(screen.getByRole('button', { name: 'Accept' }))
  expect(onSelect).toHaveBeenCalledWith(option.optionId, { name: 'Entered', code: 'AB' })
  rerender(<NativeInteractionResponse options={[option]} disabled onSelect={onSelect} />)
  expect(editor).toBeDisabled()
})

it('collects every native question, keeps secrets masked, and waits for an explicit submit', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()
  const option: ApprovalResponseOption = { ...base, label: 'Submit answers', input: { kind: 'questions', questions: [
    { id: 'path', header: 'Path', question: 'Choose the path', isOther: false, isSecret: false,
      options: [{ label: 'Fast', description: 'Less waiting' }, { label: 'Careful', description: 'Review first' }] },
    { id: 'token', header: 'Token', question: 'Enter your token', isOther: true, isSecret: true, options: null },
  ] } }
  render(<NativeInteractionResponse options={[option]} disabled={false} onSelect={onSelect} />)
  const secret = screen.getByLabelText('Your answer')
  expect(secret).toHaveAttribute('type', 'password')
  expect(onSelect).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Submit answers' }))
  expect(screen.getByRole('alert')).toBeVisible()
  expect(onSelect).not.toHaveBeenCalled()
  await user.click(screen.getByRole('checkbox', { name: /Careful/ }))
  await user.type(secret, 'entered-secret')
  await user.click(screen.getByRole('button', { name: 'Submit answers' }))
  expect(onSelect).toHaveBeenCalledWith(option.optionId, {
    path: { answers: ['Careful'] }, token: { answers: ['entered-secret'] },
  })
})

it('submits typed fields only after schema validation and allows an explicit decline without form data', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()
  const option: ApprovalResponseOption = { ...base, label: 'Accept', input: { kind: 'form', schema: {
    type: 'object', additionalProperties: false, required: ['email', 'count', 'accepted'], properties: {
      email: { title: 'Email', type: 'string', format: 'email' },
      count: { title: 'Count', type: 'integer', minimum: 1 },
      accepted: { title: 'Accepted', type: 'boolean' },
    },
  } } }
  render(<NativeInteractionResponse options={[option, decline]} disabled={false} onSelect={onSelect} />)
  await user.click(screen.getByRole('button', { name: 'Accept' }))
  expect(onSelect).not.toHaveBeenCalled()
  expect(screen.getByRole('alert')).toBeVisible()
  await user.type(screen.getByLabelText('Email (required)'), 'user@example.com')
  await user.type(screen.getByLabelText('Count (required)'), '2')
  await user.selectOptions(screen.getByLabelText('Accepted (required)'), 'false')
  await user.click(screen.getByRole('button', { name: 'Accept' }))
  expect(onSelect).toHaveBeenCalledWith(option.optionId, { email: 'user@example.com', count: 2, accepted: false })
  await user.click(screen.getByRole('button', { name: decline.label }))
  expect(onSelect).toHaveBeenLastCalledWith(decline.optionId)
})

it('edits structured form fields as JSON and locks all controls while a response is pending', async () => {
  const onSelect = vi.fn()
  const option: ApprovalResponseOption = { ...base, input: { kind: 'form', schema: {
    type: 'object', required: ['details'], properties: {
      details: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    },
  } } }
  const { rerender } = render(<NativeInteractionResponse options={[option, decline]} disabled={false} onSelect={onSelect} />)
  const user = userEvent.setup()
  await user.click(screen.getByLabelText(/details/))
  await user.paste('{"name":"entered"}')
  await userEvent.setup().click(screen.getByRole('button', { name: option.label }))
  expect(onSelect).toHaveBeenCalledWith(option.optionId, { details: { name: 'entered' } })
  rerender(<NativeInteractionResponse options={[option, decline]} disabled onSelect={onSelect} />)
  expect(screen.getByLabelText(/details/)).toBeDisabled()
  expect(screen.getByRole('button', { name: option.label })).toBeDisabled()
  expect(screen.getByRole('button', { name: decline.label })).toBeDisabled()
})

it('clears optional numeric and structured fields while retaining an intentionally empty string', async () => {
  const onSelect = vi.fn()
  const user = userEvent.setup()
  const option: ApprovalResponseOption = { ...base, input: { kind: 'form', schema: {
    type: 'object', required: ['name'], properties: {
      name: { title: 'Name', type: 'string' }, count: { title: 'Count', type: 'integer' },
      details: { title: 'Details', type: 'array', items: { type: 'string' } },
    },
  } } }
  render(<NativeInteractionResponse options={[option]} disabled={false} onSelect={onSelect} />)
  await user.type(screen.getByLabelText('Name (required)'), 'entered')
  await user.clear(screen.getByLabelText('Name (required)'))
  await user.type(screen.getByLabelText('Count'), '2')
  await user.clear(screen.getByLabelText('Count'))
  await user.click(screen.getByLabelText(/Details/))
  await user.paste('["entered"]')
  await user.clear(screen.getByLabelText(/Details/))
  await user.click(screen.getByRole('button', { name: option.label }))
  expect(onSelect).toHaveBeenCalledWith(option.optionId, { name: '' })
})
