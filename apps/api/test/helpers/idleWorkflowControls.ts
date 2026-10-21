/** Repeat-store ports for a Run with no queued chat input and no consultation. */
export const idleWorkflowRepeat = {
  async workflowControlDisposition() { return { kind: 'ordinary' as const } },
  async claimWorkflowInput() { return undefined },
}

/** Run-repository ports for the same Run with no retained terminal or output settlement. */
export const idleWorkflowControls = {
  async readOutputSettlement() { return undefined },
  async readWorkflowTerminalSettlement() { return undefined },
  async repeat() { return idleWorkflowRepeat },
}
