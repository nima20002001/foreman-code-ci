export const operatorTurnRetirementMigration = { version: 286016, sql: `
  alter table operator_conversation_turns drop constraint operator_terminal_closure_state;
  alter table operator_conversation_turns add constraint operator_terminal_closure_state check (
    (terminal_observation is null and native_closure_state is null)
    or (terminal_observation is not null and native_closure_state is not null
      and native_closure_state in ('observed','retired','pending','closed'))
  );
` } as const
