import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Store, AppError } from './storage.mjs';
import { WorkdeskService } from './workdesk-service.mjs';
import { handleMcp } from './mcp.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MIME = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml' };
const STATIC = new Set(['index.html', 'styles.css', 'app.js', 'canvas.js', 'markdown.js', 'icons.js', 'model.js', 'favicon.svg']);
async function body(req, limit) {
  let length = 0; const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw new AppError('内容超过大小限制', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' });
  res.end(JSON.stringify(value));
}
export async function createApp({ dataDir = path.join(ROOT, 'data') } = {}) {
  const store = new Store(dataDir); await store.init();
  const service = new WorkdeskService(store);
  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const host = req.headers.host || '';
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) throw new AppError('仅支持本机访问', 403);
      const url = new URL(req.url, 'http://' + host);
      const route = decodeURIComponent(url.pathname);
      if (['POST', 'PUT', 'DELETE'].includes(req.method) && req.headers.origin && req.headers.origin !== 'http://' + host) throw new AppError('拒绝来自其他网站的修改请求', 403);
      if (route === '/mcp') {
        if(req.headers.origin && req.headers.origin!=='http://'+host)throw new AppError('拒绝其他网站访问本地 MCP',403);
        let payload;
        if(req.method==='POST') {
          try {payload=JSON.parse((await body(req,16*1024*1024)).toString('utf8'));}
          catch(error){if(error instanceof AppError)throw error;throw new AppError('无法识别 MCP 请求');}
        }
        return await handleMcp(req,res,payload,service);
      }
      if (route === '/api/health' && req.method === 'GET') return json(res, 200, { app:'workdesk-local', status:'ok' });
      if (route === '/api/state' && req.method === 'GET') return json(res, 200, await store.read());
      if (route === '/api/state' && req.method === 'PUT') {
        let value;
        try { value = JSON.parse((await body(req, 16 * 1024 * 1024)).toString('utf8')); }
        catch (error) { if (error instanceof AppError) throw error; throw new AppError('无法识别工作区数据'); }
        const saved = await store.save(value.state || value,{base:value.base}); return json(res, 200, { revision:saved.revision,state:saved });
      }
      if (route === '/api/files' && req.method === 'POST') {
        return json(res, 201, await store.upload(url.searchParams.get('taskId'), url.searchParams.get('name'), await body(req, 25 * 1024 * 1024), req.headers['content-type']));
      }
      if (route.startsWith('/api/files/') && req.method === 'GET') {
        const id = route.slice('/api/files/'.length);
        const bytes = await store.file(id); const file = store.files[id];
        const inline = /^image\/(png|jpeg|webp|gif|svg\+xml|avif)$/.test(file.mime) && !url.searchParams.has('download');
        res.writeHead(200, {
          'Content-Type':inline ? file.mime : 'application/octet-stream',
          'Content-Disposition':`${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
          'Content-Length':bytes.length,
          'Content-Security-Policy':"sandbox; default-src 'none'; style-src 'unsafe-inline'", 'Cache-Control':'private, max-age=3600'
        }); return res.end(bytes);
      }
      if (route === '/api/backup' && req.method === 'GET') return json(res, 200, await store.export());
      if (route === '/api/open-folder' && req.method === 'POST') {
        if (process.platform !== 'win32') throw new AppError('数据目录：' + store.dir);
        try {
          await new Promise((resolve, reject) => {
            const explorer = spawn('explorer.exe', [store.dir], { windowsHide:false, detached:true, stdio:'ignore' });
            explorer.once('error', reject);
            // Explorer may hand the request to an existing desktop process.
            // Confirm process creation instead of waiting for its exit code.
            explorer.once('spawn', () => { explorer.unref(); resolve(); });
          });
        } catch {
          throw new AppError('无法启动资源管理器，请手动打开数据文件夹：' + store.dir, 500);
        }
        return json(res, 200, { ok:true });
      }
      const file = route === '/' ? 'index.html' : route.slice(1);
      if (req.method !== 'GET' || !STATIC.has(file)) throw new AppError('内容不存在', 404);
      const bytes = await readFile(path.join(ROOT, 'public', file));
      res.writeHead(200, { 'Content-Type':MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control':'no-cache', 'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" });
      res.end(bytes);
    } catch (error) {
      if (res.headersSent) return res.end();
      json(res, error.status || (error.code === 'ENOENT' ? 404 : 500), { error: error.status ? error.message : '本地服务暂时无法完成操作，请重试。' });
    }
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.WORKDESK_PORT || 4317);
  const server = await createApp();
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请打开 http://127.0.0.1:${port} 或设置 WORKDESK_PORT。` : error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`本地工作台\nhttp://127.0.0.1:${port}\n数据：${path.join(ROOT, 'data')}`));
}
