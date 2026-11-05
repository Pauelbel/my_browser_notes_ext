// A spot check on real sites (needs the network; run with `pnpm e2e realsites`): snapshot within 5 s and the
// budget, enough labels, links found, text read. Prints a table; fails on any miss.
const SITES = ['https://example.com', 'https://developer.mozilla.org/ru/', 'https://github.com/nanobrowser/nanobrowser',
  'https://ru.wikipedia.org/wiki/Google_Chrome', 'https://news.ycombinator.com',
  // YouTube: <body> has height 0 and everything is in positioned children; the outline was once empty.
  'https://www.youtube.com/watch?v=O_UzuW6W6e8'];
const BUDGET = 26214;

export default async function ({openPage, base, sleep, log}) {
  const dev = await openPage(`${base}/dev.html`);
  await dev.waitFor(`window.layer?.call`);
  const problems = [];
  for (const url of SITES) {
    const tab = await dev.eval(`layer.openTab(${JSON.stringify(url)})`);
    await sleep(3000);
    const call = (method, args = {}) => dev.eval(`layer.call(${tab}, ${JSON.stringify(method)}, ${JSON.stringify(args)}, ${BUDGET})`);
    const started = Date.now();
    const snap = await call('snapshot');
    const ms = Date.now() - started;
    const body = snap.text.split('<<<page-content>>>')[1]?.split('<<<end-page-content>>>')[0] ?? '';
    const labels = (body.match(/^\s*\[[a-zA-Z]+\d+\]/gm) ?? []).length;
    const links = await call('find', {role: 'link'});
    const read = await call('read');
    const notices = snap.text.split('<<<end-page-content>>>')[1]?.trim().replace(/\n/g, ' | ') ?? '';
    log(`${url.padEnd(46)} ${String(ms).padStart(5)} мс  тело ${String(body.length).padStart(6)}  меток ${String(labels).padStart(4)}  ${notices.slice(0, 120)}`);
    if (!snap.ok) problems.push(`${url}: snapshot ${snap.text.slice(0, 200)}`);
    if (ms > 6000) problems.push(`${url}: snapshot ${ms} мс`);
    if (body.length > BUDGET) problems.push(`${url}: тело ${body.length} > бюджета`);
    // example.com has a single link; every other site has many.
    if (labels < (url.includes('example.com') ? 1 : 5)) problems.push(`${url}: меток ${labels}`);
    if (!links.ok) problems.push(`${url}: find link ${links.text.slice(0, 200)}`);
    if (!read.ok || read.text.length < 200) problems.push(`${url}: read ${read.text.slice(0, 200)}`);
    await dev.eval(`layer.done(${tab})`);
  }
  if (problems.length) throw new Error(problems.join('\n'));
}
