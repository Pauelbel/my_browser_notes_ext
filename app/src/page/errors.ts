// Typed errors of the page layer. The message is for the model; `delivered` says whether an input event was sent,
// because repeating a delivered action could repeat its effect.
export type PageErrorCode = 'PAGE_NOT_SUPPORTED' | 'DETACHED' | 'TIMEOUT' | 'REF_UNKNOWN' | 'REF_STALE' | 'NOT_VISIBLE'
  | 'NOT_ENABLED' | 'NOT_STABLE' | 'COVERED' | 'NOT_EDITABLE' | 'DIALOG_OPEN' | 'VALUE_MISMATCH' | 'NOT_FOUND' | 'INTERNAL'
  | 'USER_DECLINED' | 'SITE_BLOCKED';

export class PageError extends Error {
  code: PageErrorCode;
  delivered: boolean | 'unknown';
  constructor(code: PageErrorCode, message: string, delivered: boolean | 'unknown' = false) {
    super(message);
    this.code = code;
    this.delivered = delivered;
  }
}

export const NOT_SUPPORTED_TEXT = 'Эта страница недоступна для помощника (служебная страница браузера).';
