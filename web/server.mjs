import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { contentSource } from './content.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const host = '127.0.0.1';
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/markup.mjs', ['markup.mjs', 'text/javascript; charset=utf-8']],
  ['/reading.mjs', ['reading.mjs', 'text/javascript; charset=utf-8']],
  ['/assets/cover.png', ['assets/cover.png', 'image/png']],
]);

function respond(request, response, status, body, type) {
  response.setHeader('Content-Type', type);
  response.setHeader('Cache-Control', status === 200 ? 'no-cache' : 'no-store');
  if (status === 200) {
    const etag = `"${createHash('sha256').update(body).digest('base64url')}"`;
    response.setHeader('ETag', etag);
    if (request.headers['if-none-match']?.split(/\s*,\s*/).some((tag) => tag === etag || tag === '*')) {
      response.writeHead(304).end();
      return;
    }
  }
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.writeHead(status).end(request.method === 'HEAD' ? undefined : body);
}

export function createReaderServer(projectRoot = path.dirname(here)) {
  const content = contentSource(projectRoot);
  return createServer(async (request, response) => {
    const json = (status, data) => respond(request, response, status, JSON.stringify(data), 'application/json; charset=utf-8');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'");
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.setHeader('Allow', 'GET, HEAD');
      return json(405, { error: '此地址只接受读取请求。' });
    }

    try {
      const url = new URL(request.url, `http://${host}`);
      const route = url.pathname;
      const file = staticFiles.get(route);
      if (file) {
        return respond(request, response, 200, await readFile(path.join(here, file[0])), file[1]);
      }
      const scope = { through: url.searchParams.get('through'), spoilers: url.searchParams.get('spoilers') === '1' };
      if (route === '/api/catalog') return json(200, await content.catalog(scope));
      const match = route.match(/^\/api\/(chapters|entries)\/([a-z0-9-]+)$/);
      if (match) {
        const record = match[1] === 'chapters' ? await content.chapter(match[2]) : await content.entry(match[2], scope);
        if (record) return json(200, record);
      }
      return json(404, { error: '此内容当前不可阅读。' });
    } catch (error) {
      console.error('读取站点内容失败', error.code ?? error.message);
      return json(503, { error: '内容暂时无法读取，请稍后重试。' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argument = process.argv[2] ?? process.env.MANG_YU_PORT ?? '4317';
  if (!/^\d+$/.test(argument) || Number(argument) > 65535 || process.argv.length > 3) {
    console.error('用法为 node server.mjs [端口]，端口应为 0 到 65535 的整数。');
    process.exitCode = 1;
  } else {
    const server = createReaderServer();
    server.on('error', (error) => {
      console.error(error.code === 'EADDRINUSE' ? `端口 ${argument} 已被占用，请换一个端口。` : error.message);
      process.exitCode = 1;
    });
    server.listen(Number(argument), host, () => {
      console.log(`《盲域》阅读站 http://${host}:${server.address().port}/`);
      console.log('按 Ctrl+C 停止。');
    });
  }
}
