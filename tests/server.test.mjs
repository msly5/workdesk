import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function app(t) {
  const { createApp } = await import('../server.mjs');
  const dir = await mkdtemp(path.join(tmpdir(), 'workdesk-http-'));
  const server = await createApp({ dataDir: dir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('读取状态、上传和下载保持原始字节，附件响应禁止脚本', async t => {
  const url = await app(t);
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
  const url = await app(t);
  const response = await fetch(url + '/api/state', { method: 'PUT', headers: { Origin: 'https://example.org', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 403);
  const file = await fetch(url + '/api/files/..%2fstate.json');
  assert.equal(file.status, 400);
  const traversal = await fetch(url + '/..%2fstorage.mjs');
  assert.equal(traversal.status, 404);
});

test('状态保存后重新读取，新版本冲突返回 409', async t => {
  const url = await app(t);
  const state = await (await fetch(url + '/api/state')).json();
  state.tasks[0].title = 'HTTP 验收';
  const response = await fetch(url + '/api/state', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(state) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).revision, 1);
  const conflict = await fetch(url + '/api/state', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(state) });
  assert.equal(conflict.status, 409);
});
