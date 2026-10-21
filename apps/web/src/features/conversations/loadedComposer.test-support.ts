import { screen, waitFor, within } from '@testing-library/react'
import { expect } from 'vitest'

type Queries = Pick<ReturnType<typeof within>, 'findByRole' | 'queryByText'>

/** The draft stays editable while a chat loads, in a textbox the loaded composer then replaces.
 * Wait for the loaded composer before holding on to its textbox or its Send button. */
export async function findLoadedComposer(queries: Queries = screen) {
  await queries.findByRole('textbox', { name: 'Message' })
  await waitFor(() => expect(queries.queryByText(/Loading the selected chat/)).not.toBeInTheDocument())
  return queries.findByRole('textbox', { name: 'Message' })
}
