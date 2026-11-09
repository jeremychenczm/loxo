// Turn execution core lives in @swarmdev/shared: adapter table, stream
// parsing, and process execution.
export {
  ADAPTERS,
  RUNTIME_CODE_CAPABILITIES,
  RunnerError,
  extractPlainReply,
  lowerPermission,
  parseClaudeStreamLine,
  redactDiagnostic,
  runTurn,
  type ClaudeStreamState,
  type RuntimeCodeCapability,
  type TurnCredentials,
  type TurnPermission,
  type TurnRequest,
  type TurnResult,
} from '@swarmdev/shared';
