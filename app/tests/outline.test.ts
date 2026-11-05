import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildOutline, type ONode} from '../src/page/outline.ts';
import type {Capture} from '../src/page/capture.ts';

const load = (name: string): Capture => JSON.parse(readFileSync(new URL(`./fixtures/cdp/${name}.json`, import.meta.url), 'utf8'));

/** The tree as indented `role "name"` lines, for readable assertions. */
function lines(roots: ONode[], depth = 0): string[] {
  return roots.flatMap(n => [`${'  '.repeat(depth)}${n.role}${n.name ? ` "${n.name}"` : ''}${n.value !== undefined ? ` = "${n.value}"` : ''}`, ...lines(n.children, depth + 1)]);
}
const all = (roots: ONode[]): ONode[] => roots.flatMap(n => [n, ...all(n.children)]);
const find = (roots: ONode[], role: string, name: string | RegExp) =>
  all(roots).find(n => n.role === role && (typeof name === 'string' ? n.name === name : name.test(n.name)));

test('basic: заголовок, кнопка, ссылки, без пустых generic', () => {
  const {roots} = buildOutline(load('basic'));
  const text = lines(roots).join('\n');
  assert.ok(find(roots, 'heading', 'Тестовая страница'), text);
  assert.ok(find(roots, 'button', 'Изменить статус')?.interactive, text);
  assert.ok(find(roots, 'link', 'Перейти на вторую страницу'), text);
  assert.ok(!all(roots).some(n => n.role === 'generic' && !n.name && n.children.length === 0), text);
  assert.ok(all(roots).some(n => n.kind === 'text' && n.name.includes('Первый абзац')), text);
});

test('form: пароль скрыт, у select есть значение, скрытый чекбокс представлен подписью', () => {
  const {roots} = buildOutline(load('form'));
  const text = JSON.stringify(roots);
  assert.ok(!text.includes('секрет-12345'), 'значение пароля попало в описание');
  const password = all(roots).find(n => n.role === 'textbox' && /Пароль/.test(n.name));
  assert.equal(password?.masked, true);
  const city = find(roots, 'combobox', /Город/);
  assert.equal(city?.value, '—');
  assert.equal(city?.children.length, 0);
  const news = find(roots, 'checkbox', /рассылку/);
  assert.ok(news, lines(roots).join('\n'));
  assert.equal(news?.proxy, 'label');
  assert.ok(find(roots, 'checkbox', /Согласен/));
});

test('divbuttons: div с обработчиком — clickable', () => {
  const {roots} = buildOutline(load('divbuttons'));
  const saved = find(roots, 'clickable', 'Сохранить черновик');
  assert.ok(saved?.interactive, lines(roots).join('\n'));
  assert.ok(find(roots, 'clickable', 'Удалить черновик'), lines(roots).join('\n'));
  assert.equal(all(roots).filter(n => n.name === 'Сохранить черновик').length, 1, 'текст кнопки повторился');
});

test('shadow: кнопки из открытого и закрытого shadow DOM', () => {
  const {roots} = buildOutline(load('shadow'));
  assert.ok(find(roots, 'button', 'Открытая тень'));
  assert.ok(find(roots, 'button', 'Закрытая тень'));
});

test('frames: кнопка из iframe другого сайта — под узлом Iframe, со своей сессией', () => {
  const {roots} = buildOutline(load('frames'));
  const iframes = all(roots).filter(n => n.role === 'Iframe');
  assert.equal(iframes.length, 2, lines(roots).join('\n'));
  const cross = iframes.find(f => all(f.children).some(n => n.name === 'Кнопка: Чужой'));
  assert.ok(cross, lines(roots).join('\n'));
  assert.ok(find(cross!.children, 'button', 'Кнопка: Чужой')?.sessionId);
  const same = iframes.find(f => all(f.children).some(n => n.name === 'Кнопка: Свой'));
  assert.ok(same && !find(same.children, 'button', 'Кнопка: Свой')?.sessionId);
});

test('overlay: и баннер, и кнопка под ним присутствуют', () => {
  const {roots} = buildOutline(load('overlay'));
  assert.ok(find(roots, 'button', 'Купить'));
  assert.ok(find(roots, 'button', 'Принять'));
});

test('hover: скрытый пункт меню отсутствует', () => {
  const {roots} = buildOutline(load('hover'));
  assert.ok(find(roots, 'button', 'Профиль'));
  assert.equal(find(roots, 'button', 'Выйти из профиля'), undefined);
});

test('у видимых узлов есть y, у интерактивных — backendNodeId и loaderId', () => {
  const {roots} = buildOutline(load('basic'));
  const button = find(roots, 'button', 'Изменить статус')!;
  assert.equal(typeof button.y, 'number');
  assert.equal(typeof button.backendNodeId, 'number');
  assert.ok(button.loaderId);
});

test('отказ одного фрейма — уведомление, остальное строится', () => {
  const capture = load('frames');
  const broken = {...capture, frames: capture.frames.map((f, i) => i === 2 ? {...f, nodes: [], status: 'failed' as const, reason: 'тест'} : f)};
  const {roots, notices} = buildOutline(broken);
  assert.ok(notices.some(n => n.includes('тест')), notices.join('\n'));
  assert.ok(find(roots, 'heading', 'Страница с фреймами'));
});

test('form: подпись поля не дублируется отдельным текстом', () => {
  const {roots} = buildOutline(load('form'));
  assert.equal(all(roots).filter(n => n.kind === 'text' && n.name === 'Имя').length, 0, lines(roots).join('\n'));
  assert.ok(find(roots, 'textbox', 'Имя'));
});

test('zero-body: тело нулевой высоты и display:contents не прячут страницу, обрезка нулевым блоком прячет', () => {
  // YouTube: <body> has height 0 and the whole page sits in positioned children; the outline was empty.
  const {roots} = buildOutline(load('zero-body'));
  const text = lines(roots).join('\n');
  assert.ok(find(roots, 'heading', 'Видео на странице'), text);
  assert.ok(find(roots, 'button', 'Нравится')?.interactive, text);
  assert.ok(find(roots, 'link', '1 234 комментария'), text);
  assert.ok(all(roots).some(n => n.kind === 'text' && n.name.includes('выходит из блока')), text);
  assert.ok(!text.includes('Спрятано обрезкой'), text);
  assert.ok(!find(roots, 'button', 'Скрытая кнопка'), text);
});
