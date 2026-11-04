// Static server for the fixture pages on two origins: localhost and 127.0.0.1 are different sites,
// so a page from one embedding an iframe from the other gets an out-of-process iframe.
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'pages');
const TYPES = {'.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png'};

function handler(request, response) {
  const url = new URL(request.url, 'http://x');
  if (url.pathname === '/missing') { response.writeHead(404, {'content-type': 'text/html; charset=utf-8'}); response.end('<h1>Нет такой страницы</h1>'); return; }
  if (url.pathname === '/slow') {
    setTimeout(() => { response.writeHead(200, {'content-type': 'text/plain'}); response.end('ok'); }, Number(url.searchParams.get('ms') ?? 1000));
    return;
  }
  const file = path.join(ROOT, path.normalize(url.pathname === '/' ? '/basic.html' : url.pathname));
  if (!file.startsWith(ROOT)) { response.writeHead(403); response.end(); return; }
  readFile(file).then(body => {
    response.writeHead(200, {'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream'});
    response.end(body);
  }, () => { response.writeHead(404); response.end('not found'); });
}

const listen = host => new Promise(resolve => {
  const server = http.createServer(handler);
  server.listen(0, host, () => resolve(server));
});

export async function startServer() {
  const a = await listen('127.0.0.1');
  const b = await listen('127.0.0.1');
  return {
    origin: `http://localhost:${a.address().port}`,
    crossOrigin: `http://127.0.0.1:${b.address().port}`,
    close: () => { a.close(); b.close(); },
  };
}
