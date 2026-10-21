import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentHarnessSchema, HarnessConfigurationSchema } from '@foreman-code/contracts'
import { AgentIdentity } from '../agents/AgentIdentity'
import { AgentSettingsForm } from '../graph/AgentSettingsForm'
import { HarnessBasicFields } from './HarnessBasicFields'
import { HarnessConfigurationFields } from './HarnessConfigurationFields'
import { HarnessSectionFields } from './HarnessSectionFields'
import { OperatorAccessPicker } from '../operator-chat/OperatorAccessPicker'
import { createHarnessEditor, prepareHarnessEditor } from './harnessEditor'
import { agentNodeFacts, agentSettingRows } from '../graph/signalEdge'
import { harnessSummary, retiredHarnessLabel } from './settingsPresentation'

const configuration = HarnessConfigurationSchema.parse({
  harness: 'opencode', model: 'provider/saved-model', variant: 'saved-variant',
  nativeAgent: 'saved-agent', thinking: true, autoApprove: false,
})
const agent = { id: 'historical-agent', name: 'Saved agent', harness: configuration.harness,
  model: configuration.model, harnessConfiguration: configuration }
afterEach(cleanup)

it('preserves saved OpenCode agent facts without mounting an editor or offering actions', () => {
  const original = structuredClone(agent)
  const onSave = vi.fn()
  render(<AgentSettingsForm agent={agent} initialPrompt="Saved task" onSave={onSave} onClose={vi.fn()} onRemove={vi.fn()} />)
  expect(screen.getByRole('status')).toHaveTextContent(retiredHarnessLabel)
  expect(screen.getByText('Model: provider/saved-model')).toBeVisible()
  expect(screen.getByText('Saved task')).toBeVisible()
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  expect(onSave).not.toHaveBeenCalled()
  expect(agent).toEqual(original)
})

it.each(['basic', 'configuration', 'access'] as const)('reads a retired %s configuration without controls or discovery requests', (surface) => {
  const editor = createHarnessEditor(configuration)
  const onChange = vi.fn()
  if (surface === 'basic') render(<HarnessBasicFields value={configuration} onChange={onChange} />)
  if (surface === 'configuration') render(<HarnessConfigurationFields editor={editor} onChange={onChange} />)
  if (surface === 'access') render(<OperatorAccessPicker value={configuration} disabled={false} onChange={onChange} />)
  expect(screen.getByRole('status')).toHaveTextContent(retiredHarnessLabel)
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  expect(onChange).not.toHaveBeenCalled()
  expect(editor.configuration).toEqual(configuration)
})

it.each(['model', 'permissions', 'session', 'tools', 'connections', 'workspace'] as const)(
  'does not mount controls or native discovery for a retired %s section', (section) => {
    const editor = createHarnessEditor(configuration)
    const onChange = vi.fn()
    const { container } = render(<HarnessSectionFields editor={editor} section={section} onChange={onChange} />)
    expect(container).toBeEmptyDOMElement()
    expect(onChange).not.toHaveBeenCalled()
    expect(editor.configuration).toEqual(configuration)
  })

it('lists only Codex and Claude for new choices and rejects preparing a retired configuration', () => {
  expect(AgentHarnessSchema.options).toEqual(['codex', 'claude'])
  expect(AgentHarnessSchema.safeParse('opencode').success).toBe(false)
  expect(() => prepareHarnessEditor(createHarnessEditor(configuration))).toThrow()
  expect(harnessSummary(configuration)).toContainEqual({ label: 'Harness', value: retiredHarnessLabel })
  expect(agentNodeFacts(agent)).toMatchObject({ harness: 'opencode', harnessLabel: retiredHarnessLabel, model: 'provider/saved-model' })
  expect(agentSettingRows(agent)).toContainEqual({ label: 'Harness', value: retiredHarnessLabel })
})

it('identifies a saved retired agent without presenting it as available', () => {
  render(<AgentIdentity agent={agent} />)
  expect(screen.getByText(retiredHarnessLabel)).toBeVisible()
})
