import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Store, AppError } from './storage.mjs';
import { WorkdeskService } from './workdesk-service.mjs';
import { handleMcp } from './mcp.mjs';
import { focusFolder } from './folder-window.mjs';
import {localFilePath,actOnFile} from './local-files.mjs';

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
async function localFolderPath(value) {
  let folder = value.trim();
  if (folder.startsWith('"') && folder.endsWith('"')) folder = folder.slice(1, -1).trim();
  if (!folder) throw new AppError('请先填写文件夹的完整路径。');
  if (!/^[a-z]:[\\/]/i.test(folder) || /[\u0000-\u001f<>:"|?*]/.test(folder.slice(2))) {
    throw new AppError('请填写本机完整文件夹路径，例如 D:\\项目资料。');
  }
  folder = path.win32.normalize(folder);
  let info;
  try { info = await stat(folder); }
  catch (error) {
    if (error.code === 'ENOENT') throw new AppError('文件夹不存在：' + folder, 404);
    if (error.code === 'ENOTDIR') throw new AppError('路径不是文件夹：' + folder);
    throw new AppError('无法访问文件夹，请检查路径和权限：' + folder, 403);
  }
  if (!info.isDirectory()) throw new AppError('该路径是文件，请填写文件夹路径：' + folder);
  return folder;
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
          'Content-Security-Policy':"sandbox; default-src 'none'; style-src 'unsafe-inline'", 'Cache-Control':'no-store'
        }); return res.end(bytes);
      }
      if (route === '/api/backup' && req.method === 'GET') return json(res, 200, await store.export());
      if (route === '/api/file-action' && req.method === 'POST') {
        if(process.platform!=='win32')throw new AppError('直接打开文件目前仅支持 Windows。');
        let target;
        try {target=JSON.parse((await body(req,4096)).toString('utf8'));}
        catch(error) {if(error instanceof AppError)throw error;throw new AppError('无法识别文件操作请求。');}
        if(!target || typeof target.taskId!=='string' || typeof target.cardId!=='string' || !['open','reveal'].includes(target.action))throw new AppError('请指定已保存的文件卡片和操作。');
        const state=await store.read();
        const card=state.tasks.find(t=>t.id===target.taskId)?.nodes.find(n=>n.id===target.cardId);
        if(!card)throw new AppError('文件卡片不存在。',404);
        if(!['file','image'].includes(card.type))throw new AppError('该卡片不是附件或本地文件。');
        let file;
        if(card.localFile===true)file=await localFilePath(card.filePath);
        else {
          const asset=store.files[card.assetId];
          if(!asset || asset.taskId!==target.taskId)throw new AppError('附件不存在或不属于当前任务。',404);
          file=await store.openableFile(card.assetId);
        }
        return json(res,200,await actOnFile(file,target.action));
      }
      if (route === '/api/open-folder' && req.method === 'POST') {
        if (process.platform !== 'win32') throw new AppError('数据目录：' + store.dir);
        const bytes = await body(req, 4096);
        let target = {};
        try { if (bytes.length) target = JSON.parse(bytes.toString('utf8')); }
        catch { throw new AppError('无法识别文件夹请求。'); }
        if (!target || typeof target !== 'object' || Array.isArray(target)) throw new AppError('文件夹请求格式无效。');
        let folder = store.dir;
        if (target.taskId !== undefined || target.cardId !== undefined) {
          if (typeof target.taskId !== 'string' || typeof target.cardId !== 'string') throw new AppError('请指定文件夹卡片。');
          const state = await store.read();
          const card = state.tasks.find(task => task.id === target.taskId)?.nodes.find(node => node.id === target.cardId);
          if (!card) throw new AppError('文件夹卡片不存在。', 404);
          if (card.type !== 'link' || card.localFolder !== true) throw new AppError('该卡片不是本地文件夹。');
          // Legacy folder cards without a path continue to open the data folder.
          if (card.folderPath !== undefined) folder = await localFolderPath(card.folderPath);
        }
        try {
          await new Promise((resolve, reject) => {
            const explorer = spawn('explorer.exe', [folder], { windowsHide:false, detached:true, stdio:'ignore' });
            explorer.once('error', reject);
            // Explorer may hand the request to an existing desktop process.
            // Confirm process creation instead of waiting for its exit code.
            explorer.once('spawn', () => { explorer.unref(); resolve(); });
          });
        } catch {
          throw new AppError('无法启动资源管理器，请手动打开文件夹：' + folder, 500);
        }
        const foreground = await focusFolder(folder);
        return json(res, 200, { ok:true, foreground });
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
