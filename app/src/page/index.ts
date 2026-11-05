// The page layer: observes a tab and acts on it through chrome.debugger. Deterministic, no model inside.
// Other code imports the layer only through this file.
export {acquire, release, type PageSession} from './session.ts';
export {PageError, type PageErrorCode} from './errors.ts';
export type {FrameInfo} from './frames.ts';
export {PageTools, type ToolResult, PAGE_START, PAGE_END, pageText, neutralize, normalizeUrl} from './tools.ts';
export {pageBudget} from './render.ts';
export {siteOf} from './site.ts';
export {classify, USER_STEP, type Category} from './classify.ts';
export type {Gate, GateQuestion, GateAnswer} from './tools.ts';
