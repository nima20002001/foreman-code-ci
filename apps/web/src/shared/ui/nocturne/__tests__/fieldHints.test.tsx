import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { Checkbox, RadioGroup, Switch, Textarea } from '..'
import { InfoHint } from '../../InfoHint'

it('supports label hints without hiding warnings, metadata or validation errors', async () => {
  const change = vi.fn()
  render(<>
    <Textarea label="Instructions" labelHint={<InfoHint label="Instructions">Given on each turn.</InfoHint>}
      hint="120 / 200 characters." error="Instructions are required." />
    <Switch label="Enabled" labelHint={<InfoHint label="Enabled">Runs on schedule.</InfoHint>}
      hint="Unavailable until setup finishes." onChange={change} />
    <Checkbox label="Include files" labelHint={<InfoHint label="Include files">Attach selected files.</InfoHint>} />
    <RadioGroup label="Mode" labelHint={<InfoHint label="Mode">Choose how to run.</InfoHint>}
      value="regular" options={[{ value: 'regular', label: 'Regular' }]} onValueChange={vi.fn()} />
  </>)
  expect(screen.getByRole('textbox', { name: 'Instructions' }))
    .toHaveAccessibleDescription('120 / 200 characters. Instructions are required.')
  expect(screen.getByText('120 / 200 characters.')).toBeVisible()
  expect(screen.getByText('Instructions are required.')).toBeVisible()
  expect(screen.getByText('Unavailable until setup finishes.')).toBeVisible()
  for (const label of ['Instructions', 'Enabled', 'Include files', 'Mode']) {
    const hint = screen.getByRole('button', { name: `About ${label}` })
    fireEvent.focus(hint)
    expect(screen.getByRole('tooltip')).toBeVisible()
    fireEvent.blur(hint)
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
  }
  await userEvent.click(screen.getByRole('button', { name: 'About Enabled' }))
  expect(change).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('switch', { name: 'Enabled' }))
  expect(change).toHaveBeenCalledOnce()
})
