import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function storage(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'workdesk-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { Store } = await import('../storage.mjs');
  const store = new Store(dir);
  await store.init();
  return { store, dir };
}

test('任务卡片独立保存，Markdown 落盘且重启保留', async t => {
  const { store, dir } = await storage(t);
  const state = await store.read();
  const first = state.tasks[0], second = state.tasks[1];
  const previous = JSON.stringify(second.nodes);
  const node = { id: 'test-note', type: 'markdown', title: '验收文档', content: '# 验收\n\n持久保存', x: 500, y: 300, width: 300 };
  first.nodes.push(node);
  const saved = await store.save(state);
  assert.equal(saved.revision, state.revision + 1);
  const { Store } = await import('../storage.mjs');
  const reopened = new Store(dir);
  await reopened.init();
  const loaded = await reopened.read();
  assert.equal(loaded.tasks[0].nodes.at(-1).content, node.content);
  assert.equal(JSON.stringify(loaded.tasks[1].nodes), previous);
  assert.equal(await readFile(path.join(dir, 'tasks', first.id, 'docs', 'test-note.md'), 'utf8'), node.content);
});

test('旧版本保存被拒绝，已保存内容不丢失', async t => {
  const { store } = await storage(t);
  const old = await store.read();
  const changed = structuredClone(old);
  changed.tasks[0].title = '最新工作';
  await store.save(changed);
  await assert.rejects(store.save(old), /版本/);
  assert.equal((await store.read()).tasks[0].title, '最新工作');
});

test('校验非法标识，拒绝越界文件路径', async t => {
  const { store } = await storage(t);
  const state = await store.read();
  state.tasks[0].id = '../outside';
  await assert.rejects(store.save(state), /标识/);
});

test('文件夹引用字段拒绝错误类型，路径和备注重启后保留', async t => {
  const {store,dir} = await storage(t);
  const base = await store.read();
  const card = base.tasks[0].nodes.find(node=>node.localFolder);
  for(const field of [{folderPath:{}},{localFolder:'yes'}]) {
    const invalid = structuredClone(base); Object.assign(invalid.tasks[0].nodes.find(node=>node.id===card.id),field);
    await assert.rejects(store.save(invalid), /文件夹|内容格式/);
  }
  card.folderPath='D:\\项目资料 中文'; card.content='常用工作目录'; await store.save(base);
  const {Store}=await import('../storage.mjs'); const reopened=new Store(dir); await reopened.init();
  const saved=(await reopened.read()).tasks[0].nodes.find(node=>node.id===card.id);
  assert.equal(saved.folderPath,card.folderPath); assert.equal(saved.content,card.content);
});

test('附件保存原始字节，备份包含附件', async t => {
  const { store } = await storage(t);
  const state = await store.read();
  const bytes = Buffer.from('本地附件\u0000测试');
  const file = await store.upload(state.tasks[0].id, '日志.txt', bytes, 'text/plain');
  assert.equal(file.name, '日志.txt');
  assert.deepEqual(await store.file(file.id), bytes);
  const backup = await store.export();
  assert.equal(backup.format, 'workdesk-backup-v1');
  assert.equal(backup.files[file.id].base64, bytes.toString('base64'));
});

test('附件可打开路径带扩展名，同名隔离，编辑后读取和备份仍使用同一文件', async t => {
  const {store} = await storage(t); const state = await store.read();
  const first = await store.upload(state.tasks[0].id, '会议 中文.txt', Buffer.from('原内容'), 'text/plain');
  const second = await store.upload(state.tasks[0].id, '会议 中文.txt', Buffer.from('另一个'), 'text/plain');
  const firstPath = await store.openableFile(first.id), secondPath = await store.openableFile(second.id);
  assert.equal(path.extname(firstPath), '.txt'); assert.notEqual(firstPath, secondPath);
  await writeFile(firstPath, '编辑后的内容更多');
  assert.equal(await store.openableFile(first.id), firstPath);
  assert.equal((await store.file(first.id)).toString(), '编辑后的内容更多');
  assert.equal((await store.file(second.id)).toString(), '另一个');
  const backup = await store.export();
  assert.equal(Buffer.from(backup.files[first.id].base64, 'base64').toString(), '编辑后的内容更多');
  assert.equal(backup.files[first.id].size, Buffer.byteLength('编辑后的内容更多'));
});

test('旧无扩展名附件保留原字节，兼容副本不会重复覆盖编辑结果', async t => {
  const {store,dir} = await storage(t);
  const old = path.join(dir,'files','demo-guide'); const original = await readFile(old);
  const opened = await store.openableFile('demo-guide');
  assert.equal(path.extname(opened), '.md'); assert.deepEqual(await readFile(opened), original);
  await writeFile(opened, '已编辑');
  assert.equal(await store.openableFile('demo-guide'), opened);
  assert.equal((await store.file('demo-guide')).toString(), '已编辑');
  assert.deepEqual(await readFile(old), original);
  const {Store} = await import('../storage.mjs'); const reopened = new Store(dir); await reopened.init();
  assert.equal((await reopened.file('demo-guide')).toString(), '已编辑');
});

test('本地文件引用保留路径，拒绝附件与原文件引用混用', async t => {
  const {store,dir}=await storage(t); const state=await store.read();
  const card={id:'local-doc',type:'file',localFile:true,filePath:'D:\\工作\\记录.docx',title:'记录',content:'原文件',x:10,y:20,width:310};
  state.tasks[0].nodes.push(card); await store.save(state);
  const {Store}=await import('../storage.mjs'); const reopened=new Store(dir); await reopened.init();
  assert.equal((await reopened.read()).tasks[0].nodes.at(-1).filePath,card.filePath);
  for(const fields of [{assetId:'demo-guide'},{filePath:{}},{localFile:'yes'},{type:'note'}]) {
    const invalid=await store.read(); Object.assign(invalid.tasks[0].nodes.at(-1),fields);
    await assert.rejects(store.save(invalid), /文件|内容格式/);
  }
});

test('备份读取期间的新状态修改排到备份之后，快照不会引用缺失附件', async t => {
  const { store } = await storage(t);
  const originalFile = store.file.bind(store);
  let queued, scheduled = false;
  store.file = async id => {
    if (!scheduled) {
      scheduled = true;
      queued = store.enqueue(async () => {
        store.state.tasks[0].nodes.push({id:'late-card',type:'file',title:'稍后添加',content:'',x:0,y:0,width:300,assetId:'late-asset'});
      });
      await new Promise(resolve => setImmediate(resolve));
    }
    return originalFile(id);
  };
  const backup = await store.export();
  await queued;
  for (const task of backup.state.tasks) for (const node of task.nodes) {
    if (node.assetId) assert.ok(backup.files[node.assetId], '备份缺少附件：' + node.assetId);
  }
  assert.ok((await store.read()).tasks[0].nodes.some(n => n.id === 'late-card'));
});
