import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';

async function app(t) {
  const { createApp } = await import('../server.mjs');
  const dir = await mkdtemp(path.join(tmpdir(), 'workdesk-http-'));
  const server = await createApp({ dataDir: dir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  return { url: `http://127.0.0.1:${server.address().port}`, dir };
}

test('读取状态、上传和下载保持原始字节，附件响应禁止脚本', async t => {
  const { url } = await app(t);
  const state = await (await fetch(url + '/api/state')).json();
  const bytes = Buffer.from('日志内容\u0000附件');
  const uploaded = await fetch(url + '/api/files?taskId=' + state.tasks[0].id + '&name=' + encodeURIComponent('验收.txt'), { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: bytes });
  assert.equal(uploaded.status, 201);
  const file = await uploaded.json();
  const downloaded = await fetch(url + '/api/files/' + file.id);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  assert.match(downloaded.headers.get('content-security-policy'), /sandbox/);
});

test('拒绝跨站写入与非法附件路径', async t => {
  const { url } = await app(t);
  const response = await fetch(url + '/api/state', { method: 'PUT', headers: { Origin: 'https://example.org', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 403);
  const file = await fetch(url + '/api/files/..%2fstate.json');
  assert.equal(file.status, 400);
  const traversal = await fetch(url + '/..%2fstorage.mjs');
  assert.equal(traversal.status, 404);
});

test('状态保存后重新读取，新版本冲突返回 409', async t => {
  const { url } = await app(t);
  const state = await (await fetch(url + '/api/state')).json();
  state.tasks[0].title = 'HTTP 验收';
  const response = await fetch(url + '/api/state', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(state) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).revision, 1);
  const conflict = await fetch(url + '/api/state', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(state) });
  assert.equal(conflict.status, 409);
});

// Replace only the OS boundary: tests must not open Explorer windows on the
// developer's desktop. The actual HTTP handler and data directory remain real.
function explorerStub(t, { fail = false, pending = false } = {}) {
  const calls = [];
  let notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  for (const method of ['execFile', 'spawn']) {
    const original = childProcess[method];
    t.mock.method(childProcess, method, (file, args, options, callback) => {
      if (path.basename(file).toLowerCase() !== 'explorer.exe') return original(file, args, options, callback);
      const child = new EventEmitter(); child.unref = () => {};
      calls.push({ file, args, options, child }); notifyStarted();
      if (!pending) queueMicrotask(() => {
        const error = Object.assign(new Error('Explorer unavailable'), { code: 'ENOENT' });
        if (callback) callback(fail ? error : null, '', '');
        else child.emit(fail ? 'error' : 'spawn', error);
      });
      return child;
    });
  }
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { calls, started };
}

test('打开数据文件夹使用可见窗口和实际数据路径，跨站请求不启动资源管理器', { skip: process.platform !== 'win32' }, async t => {
  const { calls } = explorerStub(t);
  const { url, dir } = await app(t);
  const response = await fetch(url + '/api/open-folder', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'C:/Windows' })
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [dir]);
  assert.notEqual(calls[0].options.windowsHide, true, '资源管理器窗口被隐藏');
  assert.ok(!calls[0].options.shell, '目录不能作为 shell 命令执行');
  const crossSite = await fetch(url + '/api/open-folder', { method: 'POST', headers: { Origin: 'https://example.org' } });
  assert.equal(crossSite.status, 403);
  assert.equal(calls.length, 1);
});

test('无法启动资源管理器时返回失败和手动打开路径', { skip: process.platform !== 'win32' }, async t => {
  explorerStub(t, { fail: true });
  const { url, dir } = await app(t);
  const response = await fetch(url + '/api/open-folder', { method: 'POST' });
  assert.equal(response.status, 500);
  const data = await response.json();
  assert.match(data.error, /无法.*资源管理器/);
  assert.ok(data.error.includes(dir));
});

test('收到系统启动确认后才返回打开请求成功', { skip: process.platform !== 'win32' }, async t => {
  const { calls, started } = explorerStub(t, { pending: true });
  const { url } = await app(t);
  const responsePromise = fetch(url + '/api/open-folder', { method: 'POST' });
  await started;
  try {
    const returnedEarly = await Promise.race([
      responsePromise.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 80))
    ]);
    assert.equal(returnedEarly, false, '系统启动尚未确认就返回了成功');
  } finally { calls[0].child.emit('spawn'); }
  assert.equal((await responsePromise).status, 200);
});
