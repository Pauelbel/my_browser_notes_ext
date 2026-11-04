// The page layer: observes a tab and acts on it through chrome.debugger. Deterministic, no model inside.
// Other code imports the layer only through this file.
export {acquire, release, type PageSession} from './session.ts';
export {PageError, type PageErrorCode} from './errors.ts';
export type {FrameInfo} from './frames.ts';
