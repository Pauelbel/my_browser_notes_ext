// Screenshots for models that see images. The OpenAI-compatible address takes images only in user messages, not in
// tool results, so the latest screenshot is added to the history as a user message right after its tool result;
// earlier screenshots are not sent again.
const CAPTION = 'Скриншот видимой части страницы (последний):';

export class ScreenshotStore {
  #latest: string | null = null;

  put(base64Jpeg: string): void {
    this.#latest = base64Jpeg;
  }

  inject<T>(messages: T[]): T[] {
    if (!this.#latest) return messages;
    // A history that already carries an injected screenshot gets it replaced, never doubled.
    messages = messages.filter(m => !((m as {role?: string; content?: unknown}).role === 'user' && Array.isArray((m as {content?: unknown}).content)
      && ((m as {content: {type?: string; text?: string}[]}).content[0]?.text ?? '').startsWith(CAPTION)));
    let at = -1;
    messages.forEach((m, i) => {
      const msg = m as {role?: string; content?: unknown};
      if (msg.role === 'tool' && Array.isArray(msg.content) && (msg.content as {toolName?: string}[]).some(p => p.toolName === 'screenshot')) at = i;
    });
    if (at < 0) return messages;
    const image = {role: 'user', content: [
      {type: 'text', text: CAPTION},
      {type: 'image', image: this.#latest, mediaType: 'image/jpeg'},
    ]} as T;
    return [...messages.slice(0, at + 1), image, ...messages.slice(at + 1)];
  }
}
