// Runs the e2e scenarios (tests/e2e/*.e2e.mjs, or the names given) in one headless Chrome with the extension.
// Each scenario exports a default async function(ctx) and throws on failure. Without Chrome: SKIP, exit 0.
import {readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {launch, chromePath} from './driver.mjs';
import {startServer} from './server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, '..', '..');
const wanted = process.argv.slice(2);
const all = (await readdir(here)).filter(f => f.endsWith('.e2e.mjs')).map(f => f.replace('.e2e.mjs', '')).sort();
// Scenarios that need the network or a model run only when named.
const explicitOnly = new Set(['record', 'realsites', 'chat-tools', 'agent', 'resume']);
const names = wanted.length ? wanted : all.filter(n => !explicitOnly.has(n));

if (!chromePath()) { console.log('SKIP: Google Chrome не найден (задайте CHROME_PATH)'); process.exit(0); }

const server = await startServer();
let failed = 0;
for (const name of names) {
  const browser = await launch(appDir);
  const started = Date.now();
  try {
    const scenario = (await import(path.join(here, `${name}.e2e.mjs`))).default;
    await scenario({...browser, server, appDir, log: (...a) => console.log('   ', ...a)});
    console.log(`ok ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    failed++;
    console.log(`not ok ${name}: ${error.stack ?? error}`);
  } finally {
    await browser.close();
  }
}
server.close();
console.log(failed ? `# fail ${failed}` : '# all ok');
process.exit(failed ? 1 : 0);
