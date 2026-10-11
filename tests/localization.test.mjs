import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store, AppError} from '../storage.mjs';
import {seedState, demoAssets} from '../seed.mjs';
import {requestLocale, localizeMessage, localizedError} from '../localization.mjs';
import {createApp} from '../server.mjs';

const englishHeaders = {'Accept-Language':'en', 'Content-Type':'application/json'};
async function directory(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'workdesk-locale-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  return dir;
}
async function storeFixture(t) {
  const dir = await directory(t), store = new Store(dir);
  await store.init(); return {dir, store};
}
async function appFixture(t, dir) {
  dir ??= await directory(t);
  const server = await createApp({dataDir:dir});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return {dir, url:'http://127.0.0.1:'+server.address().port};
}

test('语言协商尊重优先级和q=0，无header继续使用中文', () => {
  assert.equal(requestLocale(), 'zh-CN'); assert.equal(requestLocale('*'), 'zh-CN');
  assert.equal(requestLocale('en-US,en;q=0.8,zh-CN;q=0.5'), 'en');
  assert.equal(requestLocale('en;q=0,zh-TW;q=0.5'), 'zh-CN');
  assert.equal(requestLocale('en;q=0.3,zh-CN;q=0.9'), 'zh-CN');
  assert.equal(requestLocale('fr,en;q=0.8'), 'en');
});

test('英文示例覆盖所有可见文字、Markdown附件和SVG图片文字', () => {
  const state = seedState('en');
  assert.doesNotMatch(JSON.stringify(state), /\p{Script=Han}/u);
  assert.equal(state.tasks[0].title, 'Welcome to Workdesk');
  assert.equal(seedState().tasks[0].title, '本地工作台 · 第一版');
  for (const asset of demoAssets('en')) {
    assert.doesNotMatch(asset.name + asset.content, /\p{Script=Han}/u);
    assert.ok(state.tasks[0].nodes.some(node => node.assetId === asset.id && node.fileName === asset.name));
  }
});

test('首次英文读取一次性初始化英文示例和附件，切换语言及重启不改变内容', async t => {
  const {dir, url} = await appFixture(t);
  const initial = await (await fetch(url+'/api/state', {headers:englishHeaders})).json();
  assert.equal(initial.tasks[0].title, 'Welcome to Workdesk');
  assert.doesNotMatch(JSON.stringify(initial), /\p{Script=Han}/u);
  const index = JSON.parse(await readFile(path.join(dir, 'files.json'), 'utf8'));
  for (const asset of demoAssets('en')) {
    assert.equal(index[asset.id].name, asset.name);
    assert.equal(await (await fetch(url+'/api/files/'+asset.id)).text(), asset.content);
  }
  const node = initial.tasks[0].nodes.find(node => node.type === 'markdown');
  assert.equal(await readFile(path.join(dir, 'tasks', initial.tasks[0].id, 'docs', node.id+'.md'), 'utf8'), node.content);
  assert.deepEqual(await (await fetch(url+'/api/state', {headers:{'Accept-Language':'zh-CN'}})).json(), initial);
  const reopened = new Store(dir); await reopened.init(); await reopened.selectInitialLocale('zh-CN');
  assert.deepEqual(await reopened.read(), initial);
});

test('中文首次读取或已有state.json永不因英文请求重写，包括未修改的旧示例', async t => {
  const {dir, url} = await appFixture(t);
  const initial = await (await fetch(url+'/api/state')).json();
  assert.equal(initial.tasks[0].title, '本地工作台 · 第一版');
  assert.deepEqual(await (await fetch(url+'/api/state', {headers:englishHeaders})).json(), initial);
  const reopened = new Store(dir); await reopened.init(); await reopened.selectInitialLocale('en');
  assert.deepEqual(await reopened.read(), initial);
  const other = await storeFixture(t), existing = structuredClone(other.store.state);
  const previousProcess = new Store(other.dir); await previousProcess.init(); await previousProcess.selectInitialLocale('en');
  assert.deepEqual(await previousProcess.read(), existing);
});

test('先发生的读取、修改或上传取消首次示例本地化，保留用户文字和字节', async t => {
  for (const operation of ['read', 'write', 'upload']) {
    const {store} = await storeFixture(t);
    let uploaded;
    if (operation === 'read') await store.read();
    if (operation === 'write') await store.mutate(state => {state.tasks[0].nodes[0].content='用户自己的中文内容'; return {};});
    if (operation === 'upload') uploaded = await store.upload('task-welcome', '我的文件.txt', Buffer.from('用户附件'), 'text/plain');
    const expected = structuredClone(store.state);
    await store.selectInitialLocale('en');
    assert.deepEqual(await store.read(), expected);
    if (uploaded) assert.equal((await store.file(uploaded.id)).toString(), '用户附件');
  }
});

test('语言选择与写入共用队列，先选择后编辑不会覆盖本地输入', async t => {
  const {store} = await storeFixture(t);
  await Promise.all([
    store.selectInitialLocale('en'),
    store.mutate(state => {state.tasks[0].nodes[0].content='Keep this user edit 中文'; return {};})
  ]);
  const result = await store.read();
  assert.equal(result.tasks[0].title, 'Welcome to Workdesk');
  assert.equal(result.tasks[0].nodes[0].content, 'Keep this user edit 中文');
});

test('首次打开前被外部编辑的示例附件不被翻译覆盖', async t => {
  const {store, dir} = await storeFixture(t);
  await writeFile(path.join(dir, 'files', 'demo-guide'), '# User edit 用户内容');
  await store.selectInitialLocale('en');
  assert.equal((await store.read()).tasks[0].title, '本地工作台 · 第一版');
  assert.equal((await store.file('demo-guide')).toString(), '# User edit 用户内容');
});

test('首次本地化落盘失败恢复状态、索引、附件和Markdown副本', async t => {
  const {store, dir} = await storeFixture(t);
  const original = structuredClone(store.state), files = structuredClone(store.files);
  const atomic = store.atomic.bind(store); let failed = false;
  store.atomic = async (file, bytes) => {
    if (!failed && path.basename(file) === 'state.json') {failed=true; throw new Error('internal write failure');}
    return atomic(file, bytes);
  };
  await assert.rejects(store.selectInitialLocale('en'), /internal write failure/);
  assert.deepEqual(store.state, original); assert.deepEqual(store.files, files);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8')), original);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'files.json'), 'utf8')), files);
  for (const asset of demoAssets()) assert.equal(await readFile(path.join(dir, 'files', asset.id), 'utf8'), asset.content);
  const node = original.tasks[0].nodes[0];
  assert.equal(await readFile(path.join(dir, 'tasks', 'task-welcome', 'docs', node.id+'.md'), 'utf8'), node.content);
});

test('所有固定系统错误及增量校验理由都有英文，路径后缀保持原样', async () => {
  for (const name of ['server.mjs','storage.mjs','local-files.mjs','folder-window.mjs']) {
    const source = await readFile(new URL('../'+name, import.meta.url), 'utf8');
    for (const match of source.matchAll(/new AppError\('([^']*)'\s*[,)]/g)) {
      const result = localizeMessage(match[1], 'en');
      assert.doesNotMatch(result, /\p{Script=Han}/u, match[1]);
      assert.notEqual(result, localizedError(new Error(), 'en'), match[1]);
    }
  }
  const source = await readFile(new URL('../public/changes.js', import.meta.url), 'utf8');
  for (const match of source.matchAll(/fail\('([^']*)'\)/g)) {
    const result = localizeMessage('增量数据无效：'+match[1], 'en');
    assert.doesNotMatch(result, /\p{Script=Han}/u); assert.doesNotMatch(result, /the change request is invalid/);
  }
  const userPath='/Users/example/中文资料/报告.txt';
  assert.equal(localizeMessage('文件不存在或已移动，请检查路径：'+userPath, 'en'), 'The file does not exist or has moved. Check its path: '+userPath);
  assert.equal(localizeMessage('无法打开 Finder，请手动打开文件夹：'+userPath, 'en'), 'Finder could not be opened. Open this folder manually: '+userPath);
  assert.match(localizeMessage('请填写本机完整文件路径，例如 /Users/你的用户名/Documents/资料。', 'en'), /\/Users\/your-name/);
  assert.equal(localizedError(new Error('private internal details'), 'en'), 'The local service could not complete this action. Please try again.');
  assert.equal(localizedError(new AppError('Unknown internal detail'), 'en'), 'The local service could not complete this action. Please try again.');
});

test('API英文错误涵盖请求、存储、并发冲突、增量校验和跨站访问，默认中文兼容', async t => {
  const {url} = await appFixture(t);
  const missing = await fetch(url+'/missing', {headers:englishHeaders});
  assert.equal(missing.headers.get('content-language'), 'en');
  assert.equal((await missing.json()).error, 'The requested item was not found.');
  assert.equal((await (await fetch(url+'/missing')).json()).error, '内容不存在');
  const invalid = await fetch(url+'/api/state', {method:'PUT', headers:englishHeaders, body:'{'});
  assert.equal((await invalid.json()).error, 'The workspace data is not valid JSON.');
  const crossSite = await fetch(url+'/api/state', {method:'PATCH', headers:{...englishHeaders, Origin:'https://example.org'}, body:'{}'});
  assert.equal(crossSite.status, 403); assert.equal((await crossSite.json()).error, 'Changes from other websites are not allowed.');
  const badChanges = await fetch(url+'/api/state', {method:'PATCH', headers:englishHeaders, body:JSON.stringify({changes:[{op:'set',path:['revision'],after:1}]})});
  assert.equal(badChanges.status, 400); assert.match((await badChanges.json()).error, /^Invalid workspace changes: /);
  const initial = await (await fetch(url+'/api/state', {headers:englishHeaders})).json();
  const changed = structuredClone(initial); changed.tasks[0].title='Actual user title 中文';
  const saved = await fetch(url+'/api/state', {method:'PUT', headers:englishHeaders, body:JSON.stringify(changed)});
  assert.equal(saved.status, 200);
  const conflict = await fetch(url+'/api/state', {method:'PUT', headers:englishHeaders, body:JSON.stringify(initial)});
  assert.equal(conflict.status, 409); assert.doesNotMatch((await conflict.json()).error, /\p{Script=Han}/u);
  const patchConflict = await fetch(url+'/api/state', {method:'PATCH', headers:englishHeaders, body:JSON.stringify({changes:[{op:'set',path:['tasks',{id:'task-welcome'},'title'],before:initial.tasks[0].title,after:'Another title'}]})});
  assert.equal(patchConflict.status, 409); assert.match((await patchConflict.json()).error, /another window or by AI/);
  const reread = await (await fetch(url+'/api/state', {headers:englishHeaders})).json();
  assert.equal(reread.tasks[0].title, 'Actual user title 中文');
});

test('英文文件操作错误保留用户路径中的中文，不会执行系统打开命令', {skip:!['darwin','win32'].includes(process.platform)}, async t => {
  const {url, dir} = await appFixture(t);
  const state = await (await fetch(url+'/api/state', {headers:englishHeaders})).json();
  const filePath = path.join(dir, '用户资料', '不存在的文件.txt');
  state.tasks[0].nodes.push({id:'missing-local-file', type:'file', localFile:true, filePath, title:'用户标题', content:'', x:0, y:0, width:310});
  assert.equal((await fetch(url+'/api/state', {method:'PUT', headers:englishHeaders, body:JSON.stringify(state)})).status, 200);
  const response = await fetch(url+'/api/file-action', {method:'POST', headers:englishHeaders, body:JSON.stringify({taskId:state.tasks[0].id, cardId:'missing-local-file', action:'open'})});
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, 'The file does not exist or has moved. Check its path: '+filePath);
});

test('本地化静态模块可加载且API内部异常不会泄漏给英文界面', async t => {
  const {url} = await appFixture(t);
  for (const file of ['i18n.js','messages-app.js','messages-static.js','i18n.css']) {
    const response = await fetch(url+'/'+file);
    assert.equal(response.status, 200, file);
    assert.ok((await response.text()).length > 0, file);
  }
  const response = await fetch(url+'/api/state', {method:'PUT', headers:englishHeaders, body:'null'});
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error, 'The local service could not complete this action. Please try again.');
});
