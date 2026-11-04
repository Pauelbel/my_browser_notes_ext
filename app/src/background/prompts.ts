// Questions to the user from a running agent: a confirmation, a step the user does themselves, or a question that
// needs an answer. They wait in the worker, so a panel that opens later still sees them and can answer.
import type {PendingPrompt, PanelAnswer, WorkerToPanel} from '../shared/protocol.ts';

export class PromptBroker {
  readonly #emit: (event: WorkerToPanel) => void;
  readonly #open = new Map<string, {prompt: PendingPrompt; resolve: (answer: PanelAnswer) => void}>();

  constructor(emit: (event: WorkerToPanel) => void) {
    this.#emit = emit;
  }

  ask(prompt: Omit<PendingPrompt, 'id'>, signal: AbortSignal): Promise<PanelAnswer> {
    const full: PendingPrompt = {...prompt, id: crypto.randomUUID()};
    return new Promise(resolve => {
      if (signal.aborted) { resolve('cancel'); return; }
      this.#open.set(full.id, {prompt: full, resolve});
      signal.addEventListener('abort', () => this.answer(full.id, 'cancel'), {once: true});
      this.#emit({type: 'prompt', prompt: full});
    });
  }

  answer(promptId: string, answer: PanelAnswer): void {
    const open = this.#open.get(promptId);
    if (!open) return;
    this.#open.delete(promptId);
    open.resolve(answer);
    this.#emit({type: 'prompt-closed', promptId});
  }

  pending(): PendingPrompt[] {
    return [...this.#open.values()].map(o => o.prompt);
  }
}
