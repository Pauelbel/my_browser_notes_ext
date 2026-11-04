// Input events through CDP, sent to the tab's own session at top-level viewport coordinates.
// A page dialog (alert, confirm) blocks the renderer: every send races the dialog event, so nothing hangs.
import type {Point} from './geometry.ts';
import type {PageSession} from './session.ts';

export interface DialogInfo { type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'; message: string }

/** Watches for a page dialog in any session of the tab while an action runs. */
export function watchDialog(session: PageSession): {opened: Promise<DialogInfo>; current(): DialogInfo | undefined; off(): void} {
  let info: DialogInfo | undefined;
  let resolve!: (d: DialogInfo) => void;
  const opened = new Promise<DialogInfo>(r => { resolve = r; });
  const off = session.cdp.on((method, params) => {
    if (method === 'Page.javascriptDialogOpening' && !info) { info = {type: params.type, message: params.message}; resolve(info); }
  });
  return {opened, current: () => info, off};
}

async function sendRaced(session: PageSession, method: string, params: object, dialog: Promise<DialogInfo>): Promise<{dialog?: DialogInfo}> {
  const command = session.cdp.send(method, params);
  command.catch(() => {});
  return Promise.race([command.then(() => ({})), dialog.then(d => ({dialog: d}))]);
}

export async function click(session: PageSession, point: Point, dialog: Promise<DialogInfo>, count = 1): Promise<{dialog?: DialogInfo}> {
  const base = {x: point.x, y: point.y, button: 'left' as const};
  const moved = await sendRaced(session, 'Input.dispatchMouseEvent', {type: 'mouseMoved', x: point.x, y: point.y}, dialog);
  if (moved.dialog) return moved;
  for (let clickCount = 1; clickCount <= count; clickCount++) {
    const pressed = await sendRaced(session, 'Input.dispatchMouseEvent', {...base, type: 'mousePressed', clickCount}, dialog);
    if (pressed.dialog) return pressed;
    const released = await sendRaced(session, 'Input.dispatchMouseEvent', {...base, type: 'mouseReleased', clickCount}, dialog);
    if (released.dialog) return released;
  }
  return {};
}

export function hover(session: PageSession, point: Point): Promise<unknown> {
  return session.cdp.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: point.x, y: point.y});
}

export function wheel(session: PageSession, point: Point, deltaY: number): Promise<unknown> {
  return session.cdp.send('Input.dispatchMouseEvent', {type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY});
}

export type KeyName = 'Enter' | 'Tab' | 'Escape' | 'Backspace' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Space' | 'PageDown' | 'PageUp';
export const KEYS: Record<KeyName, {key: string; code: string; keyCode: number; text?: string}> = {
  Enter: {key: 'Enter', code: 'Enter', keyCode: 13, text: '\r'},
  Tab: {key: 'Tab', code: 'Tab', keyCode: 9},
  Escape: {key: 'Escape', code: 'Escape', keyCode: 27},
  Backspace: {key: 'Backspace', code: 'Backspace', keyCode: 8},
  ArrowUp: {key: 'ArrowUp', code: 'ArrowUp', keyCode: 38},
  ArrowDown: {key: 'ArrowDown', code: 'ArrowDown', keyCode: 40},
  ArrowLeft: {key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37},
  ArrowRight: {key: 'ArrowRight', code: 'ArrowRight', keyCode: 39},
  Space: {key: ' ', code: 'Space', keyCode: 32, text: ' '},
  PageDown: {key: 'PageDown', code: 'PageDown', keyCode: 34},
  PageUp: {key: 'PageUp', code: 'PageUp', keyCode: 33},
};

export async function pressKey(session: PageSession, name: KeyName, dialog: Promise<DialogInfo>): Promise<{dialog?: DialogInfo}> {
  const k = KEYS[name];
  const common = {key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode};
  const down = await sendRaced(session, 'Input.dispatchKeyEvent', {...common, type: k.text ? 'keyDown' : 'rawKeyDown', text: k.text, unmodifiedText: k.text}, dialog);
  if (down.dialog) return down;
  return sendRaced(session, 'Input.dispatchKeyEvent', {...common, type: 'keyUp'}, dialog);
}

export function insertText(session: PageSession, text: string): Promise<unknown> {
  return session.cdp.send('Input.insertText', {text});
}
