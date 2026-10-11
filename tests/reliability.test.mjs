import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../storage.mjs';
import { createApp } from '../server.mjs';
import { createChanges } from '../public/changes.js';

async function storage(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'workdesk-reliability-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir); await store.init();
  return { store, dir };
}
const fileCard = (state, file) => {
  const card = { id:'new-file', type:'file', title:file.name, content:'', assetId:file.id, x:0, y:0, width:310 };
  state.tasks.find(task => task.id === file.taskId).nodes.push(card);
  return { card };
};
async function snapshot(store, dir) {
  return {
    state:await store.read(), files:structuredClone(store.files),
    stateDisk:await readFile(path.join(dir, 'state.json'), 'utf8'),
    indexDisk:await readFile(path.join(dir, 'files.json'), 'utf8'),
    names:(await readdir(path.join(dir, 'files'))).sort(),
  };
}

test('平移与标题修改不重写 Markdown，内容修改只写对应文档', async t => {
  const { store } = await storage(t);
  const writes = [], atomic = store.atomic.bind(store);
  store.atomic = async (file, bytes) => { if (file.endsWith('.md')) writes.push(file); return atomic(file, bytes); };
  const state = await store.read(); state.tasks[0].viewport.x += 1;
  state.tasks[0].title = '只改标题'; await store.save(state);
  assert.deepEqual(writes, []);
  const next = await store.read();
  const task = next.tasks.find(task => task.nodes.some(node => node.type === 'markdown'));
  const node = task.nodes.find(node => node.type === 'markdown'); node.content += '\n追加内容';
  await store.save(next);
  assert.equal(writes.length, 1); assert.ok(writes[0].endsWith(node.id + '.md'));
});

test('附件过期版本、卡片校验失败、索引或状态落盘失败均不留下附件', async t => {
  for (const failure of ['stale', 'callback', 'invalid-card', 'files.json', 'state.json']) {
    const { store, dir } = await storage(t); const before = await snapshot(store, dir);
    const atomic = store.atomic.bind(store); let failed = false;
    store.atomic = async (file, bytes) => {
      if (!failed && path.basename(file) === failure) { failed = true; throw new Error('模拟磁盘失败'); }
      return atomic(file, bytes);
    };
    await assert.rejects(store.attach(before.state.tasks[0].id, '失败.txt', Buffer.from('附件'), 'text/plain', (state, file) => {
      if (failure === 'callback') throw new Error('卡片创建失败');
      const result = fileCard(state, file);
      if (failure === 'invalid-card') result.card.width = 0;
      return result;
    }, failure === 'stale' ? before.state.revision + 1 : before.state.revision));
    assert.deepEqual(await snapshot(store, dir), before, failure);
  }
});

test('同时附加使用同一版本时只有一次成功，重启后附件与卡片一致', async t => {
  const { store, dir } = await storage(t); const state = await store.read();
  const beforeFiles = Object.keys(store.files).length;
  const args = [state.tasks[0].id, '成功.txt', Buffer.from('字节完整'), 'text/plain', fileCard, state.revision];
  const results = await Promise.allSettled([store.attach(...args), store.attach(...args)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  const saved = results.find(result => result.status === 'fulfilled').value;
  assert.equal(saved.revision, state.revision + 1);
  assert.equal(Object.keys(store.files).length, beforeFiles + 1);
  const reopened = new Store(dir); await reopened.init();
  assert.equal((await reopened.file(saved.card.assetId)).toString(), '字节完整');
  assert.equal((await reopened.read()).tasks[0].nodes.at(-1).assetId, saved.card.assetId);
});

test('状态写入失败会恢复已修改的 Markdown 导出副本', async t => {
  const { store, dir } = await storage(t); const before = await store.read();
  const next = structuredClone(before), task = next.tasks.find(task => task.nodes.some(node => node.type === 'markdown'));
  const card = task.nodes.find(node => node.type === 'markdown');
  const file = path.join(dir, 'tasks', task.id, 'docs', card.id + '.md');
  const original = await readFile(file, 'utf8'); card.content = '不应落盘的更新';
  const atomic = store.atomic.bind(store);
  store.atomic = async (name, bytes) => { if (path.basename(name) === 'state.json') throw new Error('状态写入失败'); return atomic(name, bytes); };
  await assert.rejects(store.save(next));
  assert.deepEqual(await store.read(), before); assert.equal(await readFile(file, 'utf8'), original);
});

test('普通附件上传索引写入失败也能清理字节与内存索引', async t => {
  const { store, dir } = await storage(t); const before = await snapshot(store, dir);
  const atomic = store.atomic.bind(store);
  store.atomic = async (file, bytes) => { if (path.basename(file) === 'files.json') throw new Error('索引失败'); return atomic(file, bytes); };
  await assert.rejects(store.upload(before.state.tasks[0].id, '失败.txt', Buffer.from('附件'), 'text/plain'));
  assert.deepEqual(await snapshot(store, dir), before);
});

test('大工作区增量保存避开16MiB全量限制，并保留并发修改和跨站保护', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workdesk-delta-http-'));
  const server = await createApp({ dataDir:dir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive:true, force:true }); });
  const url = 'http://127.0.0.1:' + server.address().port;
  const initial = await (await fetch(url + '/api/state')).json();
  initial.tasks[0].nodes = Array.from({ length:15 }, (_, index) => ({ id:'large-' + index, type:'markdown', title:'大文档', content:'文'.repeat(190000), x:index * 340, y:0, width:310 }));
  initial.tasks[0].edges = [];
  const setup = await fetch(url + '/api/state', { method:'PUT', body:JSON.stringify(initial) });
  assert.equal(setup.status, 200); const base = (await setup.json()).state;
  const local = structuredClone(base); local.tasks[0].title = '大工作区仍能保存';
  assert.ok(Buffer.byteLength(JSON.stringify({ state:local, base })) > 16 * 1024 * 1024);
  const body = JSON.stringify({ changes:createChanges(base, local) }); assert.ok(Buffer.byteLength(body) < 2048);
  const remote = structuredClone(base); remote.tasks[0].nextAction = 'AI 的独立更改';
  const remoteSave = await fetch(url + '/api/state', { method:'PATCH', body:JSON.stringify({ changes:createChanges(base, remote) }) });
  assert.equal(remoteSave.status, 200);
  const result = await fetch(url + '/api/state', { method:'PATCH', body }); assert.equal(result.status, 200);
  const saved = (await result.json()).state;
  assert.equal(saved.tasks[0].title, local.tasks[0].title); assert.equal(saved.tasks[0].nextAction, remote.tasks[0].nextAction);
  assert.equal(saved.tasks[0].nodes[14].content, '文'.repeat(190000));
  assert.deepEqual(await (await fetch(url + '/api/revision')).json(), { revision:saved.revision });
  const other = structuredClone(base); other.tasks[0].title = '冲突标题';
  assert.equal((await fetch(url + '/api/state', { method:'PATCH', body:JSON.stringify({ changes:createChanges(base, other) }) })).status, 409);
  assert.equal((await fetch(url + '/api/state', { method:'PATCH', headers:{ Origin:'https://example.org' }, body })).status, 403);
  assert.equal((await fetch(url + '/api/state', { method:'PATCH', body:'{}' })).status, 400);
});
