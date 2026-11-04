// Records raw captures of fixture pages into tests/fixtures/cdp/<name>.json for the outline unit tests.
// Run by hand (pnpm e2e record) after changing capture.ts or a fixture page; commit the result.
import {writeFile} from 'node:fs/promises';
import path from 'node:path';

const PAGES = ['basic', 'form', 'overlay', 'divbuttons', 'shadow', 'frames', 'long-list', 'hover'];

export default async function ({openPage, base, server, sleep, appDir, log}) {
  const dev = await openPage(`${base}/dev.html`);
  await dev.waitFor(`window.layer?.capture`);
  for (const name of PAGES) {
    // The long list is recorded with 300 rows: the full 3000 would make a 9 MB fixture.
    const url = name === 'frames' ? `${server.origin}/frames.html?x=${server.crossOrigin}/frame-inner.html`
      : name === 'long-list' ? `${server.origin}/long-list.html?n=300` : `${server.origin}/${name}.html`;
    const tabId = await dev.eval(`layer.openTab(${JSON.stringify(url)})`);
    await sleep(1000);
    const capture = await dev.eval(`layer.capture(${tabId})`);
    if (!capture.frames?.length) throw new Error(`${name}: нет фреймов`);
    if (capture.frames.some(f => f.status !== 'captured')) throw new Error(`${name}: фрейм не снят: ${JSON.stringify(capture.frames.map(f => f.reason))}`);
    if (name === 'frames' && !capture.frames.some(f => f.url.startsWith(server.crossOrigin) && f.sessionId)) throw new Error('frames: нет фрейма другого сайта');
    if (name === 'shadow' && !capture.frames[0].nodes.some(n => n.name?.value === 'Закрытая тень')) throw new Error('shadow: нет кнопки из закрытого shadow DOM');
    // Ports differ between runs; tests should not depend on them.
    const json = JSON.stringify(capture).replaceAll(server.origin, 'http://localhost:1').replaceAll(server.crossOrigin, 'http://127.0.0.1:2');
    await writeFile(path.join(appDir, 'tests', 'fixtures', 'cdp', `${name}.json`), json);
    log(`${name}: ${capture.frames.length} фрейм(ов), ${Math.round(json.length / 1024)} КБ`);
  }
}
