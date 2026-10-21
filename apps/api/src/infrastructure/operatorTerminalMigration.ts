export const operatorTerminalMigration = { version: 285208, sql: `
  alter table operator_conversation_turns add column terminal_observation jsonb;
  alter table operator_conversation_turns add column native_closure_state text;
  alter table operator_conversation_turns add constraint operator_terminal_closure_state check (
    (terminal_observation is null and native_closure_state is null)
    or (terminal_observation is not null and native_closure_state is not null
      and native_closure_state in ('observed','pending','closed'))
  );
` } as const
