// IndexedDB storage of the assistant: conversations, messages and profiles, in the `assistant` database.
// It is separate from the notes database, which stays as version 1.0 left it.
// Every write is announced on a BroadcastChannel so the worker, the side panel and a tab stay in step.
import type {ChatMode, Conversation, Message, PermissionMode, Profile} from './types.ts';
import {titleFrom} from './title.ts';
import {DEFAULT_PROFILES, LEGACY_PROMPTS} from '../agent/profiles.ts';

const CHANNEL = 'assistant';
let db: IDBDatabase | null = null;
let channel: BroadcastChannel | null = null;

const done = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const committed = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = tx.onabort = () => reject(tx.error);
});

function database(): IDBDatabase {
  if (!db) throw new Error('База помощника не открыта');
  return db;
}

export async function openAssistantDb(name = 'assistant'): Promise<void> {
  if (db) return;
  const request = indexedDB.open(name, 1);
  request.onupgradeneeded = () => {
    const upgrade = request.result;
    upgrade.createObjectStore('conversations', {keyPath: 'id'});
    upgrade.createObjectStore('messages', {keyPath: 'id'}).createIndex('conversationId', 'conversationId');
    upgrade.createObjectStore('profiles', {keyPath: 'id'});
  };
  db = await done(request);
  channel = new BroadcastChannel(CHANNEL);
}

export function closeAssistantDb(): void {
  db?.close();
  channel?.close();
  db = null;
  channel = null;
}

function announce(conversationId?: string): void {
  channel?.postMessage({type: 'changed', conversationId});
}

/** Runs `fn` in one read-write transaction, waits for it to commit, then announces the change. */
async function write<T>(stores: string[], fn: (tx: IDBTransaction) => T | Promise<T>, conversationId?: string): Promise<T> {
  const tx = database().transaction(stores, 'readwrite');
  const result = await fn(tx);
  await committed(tx);
  announce(conversationId);
  return result;
}

// ——— Conversations ———

/** Conversations saved before modes existed read as Chat mode with Ask. */
const withDefaults = (c: Conversation): Conversation => ({...c, mode: c.mode ?? 'chat', permission: c.permission ?? 'ask'});

export async function listConversations(): Promise<Conversation[]> {
  const all = await done(database().transaction('conversations').objectStore('conversations').getAll() as IDBRequest<Conversation[]>);
  return all.map(withDefaults).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getConversation(id: string): Promise<Conversation | undefined> {
  const found = await done(database().transaction('conversations').objectStore('conversations').get(id) as IDBRequest<Conversation | undefined>);
  return found && withDefaults(found);
}

export function createConversation(init: {profileId: string; firstMessage: string; mode?: ChatMode; permission?: PermissionMode}): Promise<Conversation> {
  const now = Date.now();
  const conversation: Conversation = {
    id: crypto.randomUUID(), title: titleFrom(init.firstMessage), titleByUser: false,
    profileId: init.profileId, mode: init.mode ?? 'chat', permission: init.permission ?? 'ask', createdAt: now, updatedAt: now,
  };
  return write(['conversations'], tx => { tx.objectStore('conversations').put(conversation); return conversation; }, conversation.id);
}

/** Reads a conversation inside `tx`, applies `change` and puts it back; does nothing when it is gone. */
function updateConversation(tx: IDBTransaction, id: string, change: (c: Conversation) => void): Promise<boolean> {
  const store = tx.objectStore('conversations');
  return done(store.get(id) as IDBRequest<Conversation | undefined>).then(found => {
    if (!found) return false;
    change(found);
    store.put(found);
    return true;
  });
}

export async function renameConversation(id: string, title: string): Promise<void> {
  await write(['conversations'], tx => updateConversation(tx, id, c => { c.title = title; c.titleByUser = true; }), id);
}

export async function setConversationProfile(id: string, profileId: string): Promise<void> {
  await write(['conversations'], tx => updateConversation(tx, id, c => { c.profileId = profileId; }), id);
}

export async function setConversationMode(id: string, mode: ChatMode, permission: PermissionMode): Promise<void> {
  await write(['conversations'], tx => updateConversation(tx, id, c => { c.mode = mode; c.permission = permission; }), id);
}

export async function deleteConversation(id: string): Promise<void> {
  await write(['conversations', 'messages'], async tx => {
    tx.objectStore('conversations').delete(id);
    const messages = tx.objectStore('messages');
    const keys = await done(messages.index('conversationId').getAllKeys(id));
    for (const key of keys) messages.delete(key);
  }, id);
}

// ——— Messages ———

export async function listMessages(conversationId: string): Promise<Message[]> {
  const index = database().transaction('messages').objectStore('messages').index('conversationId');
  const all = await done(index.getAll(conversationId) as IDBRequest<Message[]>);
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

/** Writes the message and bumps its conversation; a message of a deleted conversation is dropped. */
export async function putMessage(message: Message): Promise<void> {
  await write(['conversations', 'messages'], async tx => {
    const exists = await updateConversation(tx, message.conversationId, c => {
      c.updatedAt = Math.max(c.updatedAt, message.createdAt);
    });
    if (exists) tx.objectStore('messages').put(message);
  }, message.conversationId);
}

/** Marks replies left `streaming` by a worker that stopped as `interrupted`; returns how many. */
export async function markInterrupted(): Promise<number> {
  const stuck = await write(['messages'], async tx => {
    const store = tx.objectStore('messages');
    const all = await done(store.getAll() as IDBRequest<Message[]>);
    const found = all.filter(m => m.status === 'streaming');
    for (const m of found) store.put({...m, status: 'interrupted'});
    return found;
  });
  // Each affected chat is announced, so a panel showing one re-reads it.
  for (const id of new Set(stuck.map(m => m.conversationId))) announce(id);
  return stuck.length;
}

// ——— Profiles ———

export async function listProfiles(): Promise<Profile[]> {
  const all = await done(database().transaction('profiles').objectStore('profiles').getAll() as IDBRequest<Profile[]>);
  if (all.length) {
    const upgraded = all.map(p => {
      const fresh = DEFAULT_PROFILES.find(d => d.id === p.id);
      return fresh && LEGACY_PROMPTS[p.id]?.includes(p.prompt) ? {...p, prompt: fresh.prompt} : p;
    });
    const changed = upgraded.filter((p, i) => p !== all[i]);
    if (changed.length) await write(['profiles'], tx => { for (const p of changed) tx.objectStore('profiles').put(p); });
    return upgraded.sort((a, b) => a.createdAt - b.createdAt);
  }
  await write(['profiles'], tx => { for (const p of DEFAULT_PROFILES) tx.objectStore('profiles').put(p); });
  return DEFAULT_PROFILES.map(p => ({...p, tools: [...p.tools]}));
}

export async function putProfile(profile: Profile): Promise<void> {
  await write(['profiles'], tx => { tx.objectStore('profiles').put(profile); });
}

export async function deleteProfile(id: string): Promise<void> {
  await write(['profiles'], async tx => {
    const store = tx.objectStore('profiles');
    const count = await done(store.count());
    if (count <= 1) throw new Error('Нельзя удалить последний профиль');
    store.delete(id);
  });
}

export function onAssistantChange(callback: (event: {conversationId?: string}) => void): () => void {
  const listener = new BroadcastChannel(CHANNEL);
  listener.onmessage = event => { if (event.data?.type === 'changed') callback({conversationId: event.data.conversationId}); };
  return () => listener.close();
}
