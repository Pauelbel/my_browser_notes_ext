import {test} from 'node:test';
import assert from 'node:assert/strict';
import {findOverlaps, findUnnamed} from '../src/page/checks.ts';
import type {ONode} from '../src/page/outline.ts';

const node = (role: string, name: string, children: ONode[] = []): ONode => ({role, name, states: [], children, kind: 'element', frameId: 'F', loaderId: 'L', backendNodeId: 1, interactive: ['button', 'link', 'textbox'].includes(role)});

test('findUnnamed: интерактивные элементы без имени', () => {
  const roots = [node('heading', ''), node('button', ''), node('button', 'Ок'), node('generic', '', [node('link', ''), node('textbox', 'Имя')])];
  assert.deepEqual(findUnnamed(roots).map(n => n.role), ['button', 'link']);
});

test('findOverlaps: пересечение больше 30 % меньшего', () => {
  const box = (x: number, y: number, w: number, h: number) => ({x, y, width: w, height: h});
  assert.deepEqual(findOverlaps([{ref: 'a1', label: 'A', box: box(0, 0, 100, 40)}, {ref: 'a2', label: 'B', box: box(50, 0, 100, 40)}]), [['a1', 'a2']]);
  assert.deepEqual(findOverlaps([{ref: 'a1', label: 'A', box: box(0, 0, 100, 40)}, {ref: 'a2', label: 'B', box: box(90, 0, 100, 40)}]), []);
});
