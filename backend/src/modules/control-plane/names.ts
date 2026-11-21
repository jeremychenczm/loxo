/** The MCP server name a run reaches the control plane under. */
export const CONTROL_PLANE_SERVER = 'swarmdev';

/** The control plane's tools, by the names agents call them. */
export const CONTROL_PLANE_TOOLS = [
  'get_task',
  'comment_on_task',
  'update_task_status',
  'submit_review',
  'ask_blocker',
  'submit_result',
] as const;
