import {test} from 'node:test';
import assert from 'node:assert/strict';
import {quadArea, quadCenter, toParent, visibleCenter} from '../src/page/geometry.ts';

const rect = (x: number, y: number, w: number, h: number) => [x, y, x + w, y, x + w, y + h, x, y + h];

test('quadCenter и quadArea', () => {
  assert.deepEqual(quadCenter(rect(10, 20, 100, 40)), {x: 60, y: 40});
  assert.equal(quadArea(rect(0, 0, 10, 5)), 50);
});

test('visibleCenter: центр видимой части, null вне экрана', () => {
  assert.deepEqual(visibleCenter(rect(-50, 100, 100, 20), {width: 800, height: 600}), {x: 25, y: 110});
  assert.deepEqual(visibleCenter(rect(100, 590, 50, 40), {width: 800, height: 600}), {x: 125, y: 595});
  assert.equal(visibleCenter(rect(100, 700, 50, 40), {width: 800, height: 600}), null);
});

test('toParent: точка дочернего окна на четырёхугольнике владельца', () => {
  assert.deepEqual(toParent({x: 200, y: 150}, rect(100, 50, 400, 300), {width: 400, height: 300}), {x: 300, y: 200});
  assert.deepEqual(toParent({x: 200, y: 150}, rect(100, 50, 200, 150), {width: 400, height: 300}), {x: 200, y: 125});
});
