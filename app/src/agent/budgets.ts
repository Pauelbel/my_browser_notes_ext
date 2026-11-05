// One account of the model's window for a reply: the system prompt and the tool definitions take their share, a
// reserve is kept for the answer, and the rest is split between the chat's earlier messages and the run itself.
// Sizes are counted at 3 characters a token: Cyrillic text takes more tokens than 4 characters each.
const OUTPUT_RESERVE = 2048;
const PER_TOOL = 60;

export function budgets(o: {context: number; system: string; tools: Record<string, {description?: string}>; agent: boolean}): {run: number; history: number} {
  const toolTokens = Object.values(o.tools).reduce((sum, t) => sum + PER_TOOL + Math.ceil((t.description ?? '').length / 3), 0);
  const overhead = Math.ceil(o.system.length / 3) + toolTokens;
  const run = Math.max(1024, o.context - overhead - OUTPUT_RESERVE);
  // An agent run grows with every step: the chat's earlier messages get a quarter, a chat reply gets half.
  return {run, history: Math.round(run * (o.agent ? 0.25 : 0.5))};
}
