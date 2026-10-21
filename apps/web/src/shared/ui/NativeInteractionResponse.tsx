import { asRecord } from '../records'
import { useId, useState } from 'react'
import { validateInteractionResponse, type ApprovalResponseOption, type InteractionResponseValue,
  type NativeInteractionInput } from '@foreman-code/contracts'
import { Button } from './nocturne'
import { approvalOptionScope } from './approvalOptionScope'
import './nativeInteractionResponse.css'


function editableFormProperties(input: Extract<NativeInteractionInput, { kind: 'form' }>) {
  const schema = asRecord(input.schema)
  const properties = asRecord(schema.properties)
  const fieldKeywords = ['type', 'properties', 'required', 'additionalProperties', 'title', 'description', '$schema']
  const required = Array.isArray(schema.required) ? schema.required : []
  const canRender = Object.keys(properties).length > 0
    && (schema.type === undefined || schema.type === 'object')
    && Object.keys(schema).every((keyword) => fieldKeywords.includes(keyword))
    && required.every((name) => typeof name === 'string' && Object.hasOwn(properties, name))
    && typeof schema.additionalProperties !== 'object'
  return canRender ? properties : undefined
}

function FormFields({ input, disabled, values, update }: {
  input: Extract<NativeInteractionInput, { kind: 'form' }>; disabled: boolean
  values: Record<string, unknown>; update(name: string, value: unknown): void
}) {
  const schema = asRecord(input.schema)
  const properties = editableFormProperties(input)
  if (!properties) return <label>Form response (JSON)
    <textarea disabled={disabled} value={String(values.json ?? '{}')} onChange={(event) => update('json', event.target.value)} />
    <small>Enter the complete response as JSON.</small>
  </label>
  return <>{Object.entries(properties).map(([name, property]) => {
    const field = asRecord(property)
    const label = typeof field.title === 'string' ? field.title : name
    const value = Object.hasOwn(values, name) ? values[name] ?? '' : ''
    const choices = Array.isArray(field.enum) ? field.enum : undefined
    const required = Array.isArray(schema.required) && schema.required.includes(name)
    const isNumber = field.type === 'number' || field.type === 'integer'
    const isStructured = !['string', 'number', 'integer', 'boolean'].includes(String(field.type))
    let editor
    if (choices || field.type === 'boolean') {
      const selected = Object.hasOwn(values, name) && values[name] !== undefined ? JSON.stringify(values[name]) : ''
      editor = <select disabled={disabled} value={selected} onChange={(event) => update(name,
        event.target.value ? JSON.parse(event.target.value) : undefined)}>
        <option value="">Choose a value</option>
        {(choices ?? [true, false]).map((choice) => {
          let choiceLabel = JSON.stringify(choice)
          if (field.type === 'boolean') choiceLabel = choice ? 'Yes' : 'No'
          else if (typeof choice === 'string') choiceLabel = choice
          return <option key={JSON.stringify(choice)} value={JSON.stringify(choice)}>{choiceLabel}</option>
        })}
      </select>
    } else if (isStructured) {
      editor = <textarea disabled={disabled} value={String(value)}
        onChange={(event) => update(name, event.target.value || undefined)} />
    } else {
      let inputType = 'text'
      if (isNumber) inputType = 'number'
      else if (field.format === 'password' || field.writeOnly === true) inputType = 'password'
      editor = <input disabled={disabled} type={inputType} step={field.type === 'integer' ? 1 : 'any'}
        value={String(value)} onChange={(event) => {
          let next: string | number | undefined = event.target.value
          if (isNumber) next = event.target.value ? Number(event.target.value) : undefined
          update(name, next)
        }} />
    }
    return <label key={name}>{label}{required ? ' (required)' : ''}
      {editor}
      {typeof field.description === 'string' ? <small>{field.description}</small> : null}
      {isStructured ? <small>Enter a JSON value.</small> : null}
    </label>
  })}</>
}

function QuestionFields({ input, disabled, values, update }: {
  input: Extract<NativeInteractionInput, { kind: 'questions' }>; disabled: boolean
  values: Record<string, unknown>; update(name: string, value: unknown): void
}) {
  return <>{input.questions.map((question) => {
    const answer = asRecord(values[question.id])
    const selected = Array.isArray(answer.choices) ? answer.choices as string[] : []
    return <fieldset key={question.id} disabled={disabled}>
      <legend>{question.header}</legend><p>{question.question}</p>
      {question.options?.map((option) => <label key={option.label}>
        <input type="checkbox" checked={selected.includes(option.label)} onChange={(event) => update(question.id,
          { ...answer, choices: event.target.checked ? [...selected, option.label]
            : selected.filter((label) => label !== option.label) })} />
        {option.label}{option.description ? <small>{option.description}</small> : null}
      </label>)}
      {question.isOther || !question.options?.length ? <label>{question.isOther ? 'Your answer' : question.question}
        <input type={question.isSecret ? 'password' : 'text'} value={String(answer.other ?? '')}
          onChange={(event) => update(question.id, { ...answer, other: event.target.value })} />
      </label> : null}
    </fieldset>
  })}</>
}

function responseValue(input: NativeInteractionInput, values: Record<string, unknown>): InteractionResponseValue {
  if (input.kind === 'questions') {
    return Object.fromEntries(input.questions.map((question) => {
      const answer = asRecord(values[question.id])
      const selected = Array.isArray(answer.choices) ? answer.choices as string[] : []
      const other = String(answer.other ?? '')
      return [question.id, { answers: typeof answer.other === 'string' ? [...selected, other] : selected }]
    }))
  }
  const properties = editableFormProperties(input)
  if (!properties) return JSON.parse(String(values.json ?? '{}')) as InteractionResponseValue
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined).map(([name, value]) => {
    const field = asRecord(properties[name])
    const structured = !Array.isArray(field.enum) && !['string', 'number', 'integer', 'boolean'].includes(String(field.type))
    const parsed = structured ? JSON.parse(String(value)) as InteractionResponseValue : value as InteractionResponseValue
    return [name, parsed]
  }))
}

export function NativeInteractionResponse({ options, disabled, onSelect }: {
  options: ApprovalResponseOption[]; disabled: boolean
  onSelect(optionId: string, response?: InteractionResponseValue): void
}) {
  const input = options.find((option) => option.input)?.input
  const scopeId = useId()
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [error, setError] = useState<string>()
  const update = (name: string, value: unknown) => {
    setValues((previous) => ({ ...previous, [name]: value }))
    setError(undefined)
  }
  const submit = (option: ApprovalResponseOption) => {
    if (!option.input) {
      onSelect(option.optionId)
      return
    }
    try {
      const response = responseValue(option.input, values)
      validateInteractionResponse(option.input, response)
      onSelect(option.optionId, response)
    } catch (cause) {
      setError(cause instanceof Error ? `Check your answers: ${cause.message}` : 'Check your answers before submitting.')
    }
  }
  if (!input) return null
  return <div className="native-interaction-response">
    {input.kind === 'questions' ? <QuestionFields input={input} disabled={disabled} values={values} update={update} />
      : <FormFields input={input} disabled={disabled} values={values} update={update} />}
    {error ? <p role="alert">{error}</p> : null}
    <div className="operator-approval-actions">{options.map((option) => {
      const descriptionId = `${scopeId}-${encodeURIComponent(option.optionId)}`
      return <div key={option.optionId} className="operator-approval-choice">
        <Button size="sm" disabled={disabled} aria-describedby={descriptionId}
          onClick={() => submit(option)}>{option.label}</Button>
        <p id={descriptionId} className="operator-approval-scope">{option.scopeSummary} {approvalOptionScope(option)}</p>
      </div>
    })}</div>
  </div>
}
