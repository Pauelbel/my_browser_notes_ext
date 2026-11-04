// The notes module opens a BroadcastChannel when it loads and never closes it (a page lives as long as its tab).
// In a test process that channel would keep Node running; unref() lets the process exit when the tests are done.
const Original = globalThis.BroadcastChannel;
globalThis.BroadcastChannel = class extends Original {
  constructor(name: string) {
    super(name);
    (this as unknown as {unref?: () => void}).unref?.();
  }
} as typeof BroadcastChannel;
