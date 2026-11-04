// Element labels: one label per node per document, prefixed with the session's epoch. A label is valid only in the
// document it was seen in and only in this session; anything else fails closed instead of guessing.
import {PageError} from './errors.ts';
import type {ONode} from './outline.ts';

export interface RefRecord {
  ref: string;
  frameId: string;
  sessionId?: string;
  backendNodeId: number;
  loaderId: string;
  role: string;
  name: string;
  proxy?: 'label';
  stale?: boolean;
}

export class RefRegistry {
  readonly epoch: string;
  #counter = 0;
  #byRef = new Map<string, RefRecord>();
  #byKey = new Map<string, RefRecord>();

  constructor(epoch: string) {
    this.epoch = epoch;
  }

  /** The node's label: the existing one for this node in this document, else a new one. Sets `node.ref`. */
  assign(node: ONode): string {
    const key = `${node.sessionId ?? ''}|${node.loaderId}|${node.backendNodeId}`;
    let record = this.#byKey.get(key);
    if (!record || record.stale) {
      record = {
        ref: `${this.epoch}${++this.#counter}`, frameId: node.frameId, sessionId: node.sessionId, backendNodeId: node.backendNodeId ?? -1,
        loaderId: node.loaderId, role: node.role, name: node.name, proxy: node.proxy,
      };
      this.#byKey.set(key, record);
      this.#byRef.set(record.ref, record);
    } else {
      record.role = node.role;
      record.name = node.name;
    }
    node.ref = record.ref;
    return record.ref;
  }

  get(ref: string): RefRecord {
    const record = this.#byRef.get(ref.trim().replace(/^\[|\]$/g, ''));
    if (!record) throw new PageError('REF_UNKNOWN', `Метка ${ref} не из этого снимка: сделайте snapshot и используйте метки из него.`);
    if (record.stale) throw new PageError('REF_STALE', `Метка ${ref} устарела: страница или фрейм перезагрузились. Сделайте snapshot.`);
    return record;
  }

  /** A frame loaded a new document: every label from its old documents goes stale. */
  invalidateFrame(frameId: string, loaderId: string): void {
    for (const record of this.#byRef.values()) if (record.frameId === frameId && record.loaderId !== loaderId) record.stale = true;
  }
}
