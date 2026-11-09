// One account of the model's window for a reply: the system prompt and the tool definitions take their share, a
// reserve is kept for the answer, and the rest is split between the chat's earlier messages and the run itself.
// Sizes are counted at 3 characters a token: Cyrillic text takes more tokens than 4 characters each.
const OUTPUT_RESERVE = 2048;
const PER_TOOL = 60;

interface ToolDescription {description?: string}

const toolTokens = (tools: Record<string, ToolDescription>) => Object.values(tools)
  .reduce((sum, tool) => sum + PER_TOOL + Math.ceil((tool.description ?? '').length / 3), 0);

/** Approximate occupancy of the model window before it starts generating an answer. */
export function measureContext(o: {context: number; system: string; tools: Record<string, ToolDescription>;
  messages: {content: unknown}[]}): {used: number; limit: number; system: number; tools: number; history: number} {
  const system = Math.ceil(o.system.length / 3);
  const tools = toolTokens(o.tools);
  const history = Math.ceil(o.messages.reduce((sum, message) => sum
    + (typeof message.content === 'string' ? message.content.length : JSON.stringify(message.content).length), 0) / 3);
  return {used: Math.min(o.context, system + tools + history), limit: o.context, system, tools, history};
}

export function budgets(o: {context: number; system: string; tools: Record<string, {description?: string}>; agent: boolean}): {run: number; history: number} {
  const overhead = Math.ceil(o.system.length / 3) + toolTokens(o.tools);
  const run = Math.max(1024, o.context - overhead - OUTPUT_RESERVE);
  // An agent run grows with every step: the chat's earlier messages get a quarter, a chat reply gets half.
  return {run, history: Math.round(run * (o.agent ? 0.25 : 0.5))};
}
