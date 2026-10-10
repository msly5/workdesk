import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
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
  assert.equal(downloaded.headers.get('cache-control'),'no-store');
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
function explorerStub(t, { fail = false, pending = false, foreground = true, focusFails = false, openFails = false } = {}) {
  const calls = [], focusCalls = [], openCalls = [];
  let notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  for (const method of ['execFile', 'spawn']) {
    const original = childProcess[method];
    t.mock.method(childProcess, method, (file, args, options, callback) => {
      if (path.basename(file).toLowerCase() === 'powershell.exe' && args.some(arg => arg.endsWith('open-file.ps1'))) {
        openCalls.push({file,args,options});
        queueMicrotask(() => callback(openFails ? new Error('Default app unavailable') : null, '', ''));
        return new EventEmitter();
      }
      if (path.basename(file).toLowerCase() === 'powershell.exe' && args.some(arg => arg.endsWith('focus-folder.ps1'))) {
        focusCalls.push({file,args,options});
        queueMicrotask(() => callback(focusFails ? new Error('Focus helper unavailable') : null, JSON.stringify({foreground}), ''));
        return new EventEmitter();
      }
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
  return { calls, started, focusCalls, openCalls };
}

async function saveFileCard(url, fields) {
  const state=await (await fetch(url+'/api/state')).json(); const task=state.tasks[0];
  const card={id:'file-action-card',type:'file',title:'文件操作',content:'',x:0,y:0,width:310,...fields};
  task.nodes=task.nodes.filter(n=>n.id!==card.id); task.nodes.push(card);
  const saved=await fetch(url+'/api/state',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(state)});
  assert.equal(saved.status,200); return {taskId:task.id,cardId:card.id};
}
function fileAction(url,target,action='open',headers={}) {
  return fetch(url+'/api/file-action',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({...target,action})});
}
test('附件由默认程序打开带扩展名副本，定位选择同一个文件，编辑后下载同步', {skip:process.platform!=='win32'}, async t=>{
  const {openCalls,calls,focusCalls}=explorerStub(t); const {url}=await app(t);
  const state=await (await fetch(url+'/api/state')).json();
  const asset=await (await fetch(url+'/api/files?taskId='+state.tasks[0].id+'&name='+encodeURIComponent('报告 中文 & ;.txt'),{method:'POST',body:'原内容'})).json();
  const target=await saveFileCard(url,{assetId:asset.id});
  assert.equal((await fileAction(url,target)).status,200);
  const file=openCalls[0].options.env.WORKDESK_OPEN_FILE;
  assert.equal(path.extname(file),'.txt'); assert.ok(file.includes(asset.id));
  assert.ok(!openCalls[0].args.includes(file)); assert.ok(!openCalls[0].args.includes('-Command'));
  await writeFile(file,'外部编辑后的内容');
  const reveal=await fileAction(url,target,'reveal'); assert.equal(reveal.status,200);
  assert.equal((await reveal.json()).foreground,true);
  assert.deepEqual(calls[0].args,['/select,','"'+file+'"']);
  assert.equal(calls[0].options.windowsVerbatimArguments,true);
  assert.equal(focusCalls[0].options.env.WORKDESK_FOCUS_FOLDER,path.dirname(file));
  assert.equal(await (await fetch(url+'/api/files/'+asset.id)).text(),'外部编辑后的内容');
});
test('本地文件引用直接使用保存的原路径，特殊字符不成为命令', {skip:process.platform!=='win32'}, async t=>{
  const {openCalls,calls}=explorerStub(t); const {url,dir}=await app(t);
  const file=path.join(dir,"原文件 中文 & ; ' , 空格.txt"); await writeFile(file,'原文件');
  const target=await saveFileCard(url,{localFile:true,filePath:' "'+file.replaceAll('\\','/')+'" '});
  assert.equal((await fileAction(url,target)).status,200);
  assert.equal(openCalls[0].options.env.WORKDESK_OPEN_FILE,file);
  assert.equal((await fileAction(url,target,'reveal')).status,200);
  assert.deepEqual(calls[0].args,['/select,','"'+file+'"']);
  assert.ok(!calls[0].options.shell);
  const comma=path.join(dir,'report,2026.csv'); await writeFile(comma,'test');
  const commaTarget=await saveFileCard(url,{localFile:true,filePath:comma});
  assert.equal((await fileAction(url,commaTarget,'reveal')).status,200);
  assert.deepEqual(calls[1].args,['/select,','"'+comma+'"']);
  assert.equal(calls[1].options.windowsVerbatimArguments,true);
});
test('本地文件动作拒绝错误卡片、跨站、非法路径及不存在文件', {skip:process.platform!=='win32'}, async t=>{
  const {openCalls,calls}=explorerStub(t); const {url,dir}=await app(t);
  const state=await (await fetch(url+'/api/state')).json();
  assert.equal((await fileAction(url,{path:'C:\\Windows\\notepad.exe'})).status,400);
  assert.equal((await fileAction(url,{taskId:state.tasks[0].id,cardId:'missing'})).status,404);
  assert.equal((await fileAction(url,{taskId:state.tasks[0].id,cardId:state.tasks[0].nodes.find(n=>n.type==='markdown').id})).status,400);
  for(const [value,status] of [['',400],['relative.txt',400],['https://example.org',400],['\\\\server\\share\\a.txt',400],[dir,400],[path.join(dir,'missing.txt'),404]]) {
    const target=await saveFileCard(url,{localFile:true,filePath:value});
    assert.equal((await fileAction(url,target)).status,status,value);
  }
  const target=await saveFileCard(url,{localFile:true,filePath:path.join(dir,'missing.txt')});
  assert.equal((await fileAction(url,target,'open',{Origin:'https://example.org'})).status,403);
  assert.equal((await fileAction(url,target,'execute')).status,400);
  assert.equal(openCalls.length,0); assert.equal(calls.length,0);
});
test('程序和脚本可定位但不直接运行，默认程序启动失败返回可操作错误', {skip:process.platform!=='win32'}, async t=>{
  const {openCalls}=explorerStub(t,{openFails:true}); const {url,dir}=await app(t);
  const script=path.join(dir,'脚本.cmd'); await writeFile(script,'test');
  let target=await saveFileCard(url,{localFile:true,filePath:script});
  assert.equal((await fileAction(url,target)).status,400); assert.equal(openCalls.length,0);
  for(const name of ['.cmd','.exe','命令.pif','脚本.cmd.']) {
    const file=path.join(dir,name); await writeFile(file,'test');
    const program=await saveFileCard(url,{localFile:true,filePath:file});
    assert.equal((await fileAction(url,program)).status,400,name);
  }
  assert.equal(openCalls.length,0);
  assert.equal((await fileAction(url,target,'reveal')).status,200);
  const file=path.join(dir,'记录.txt'); await writeFile(file,'内容');
  target=await saveFileCard(url,{localFile:true,filePath:file});
  const response=await fileAction(url,target); assert.equal(response.status,500);
  assert.match((await response.json()).error,/默认程序|打开/);
});

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

async function saveFolderCard(url, folderPath) {
  const state = await (await fetch(url + '/api/state')).json();
  const task = state.tasks[0];
  const card = { id: 'custom-folder', type: 'link', title: '项目资料', localFolder: true, folderPath, content: '', x: 500, y: 400, width: 310 };
  task.nodes = task.nodes.filter(node => node.id !== card.id); task.nodes.push(card);
  const response = await fetch(url + '/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state) });
  assert.equal(response.status, 200);
  return { taskId: task.id, cardId: card.id };
}

test('从已保存的文件夹卡片打开指定中文空格目录，兼容复制的引号且不执行命令', { skip: process.platform !== 'win32' }, async t => {
  const { calls } = explorerStub(t);
  const { url, dir } = await app(t);
  const folder = path.join(dir, '资料 & 项目; 中文 空格'); await mkdir(folder);
  const target = await saveFolderCard(url, ' "' + folder.replaceAll('\\', '/') + '" ');
  const response = await fetch(url + '/api/open-folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(target) });
  assert.equal(response.status, 200);
  assert.deepEqual(calls[0].args, [folder]);
  assert.ok(!calls[0].options.shell);
  const forbidden = await fetch(url + '/api/open-folder', { method: 'POST', headers: { Origin: 'https://example.org', 'Content-Type': 'application/json' }, body: JSON.stringify(target) });
  assert.equal(forbidden.status, 403); assert.equal(calls.length, 1);
});

test('文件夹路径为空、相对地址、协议、网络路径、普通文件或不存在时不启动 Explorer', { skip: process.platform !== 'win32' }, async t => {
  const { calls } = explorerStub(t);
  const { url, dir } = await app(t);
  const file = path.join(dir, '普通文件.txt'); await writeFile(file, '不能作为程序打开');
  for (const [value, status] of [['',400],['relative',400],['https://example.org',400],['shell:AppsFolder',400],['\\\\server\\share',400],['\\\\?\\C:\\',400],[file,400],[path.join(dir,'不存在'),404]]) {
    const target = await saveFolderCard(url, value);
    const response = await fetch(url + '/api/open-folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(target) });
    assert.equal(response.status, status, value);
    assert.match((await response.json()).error, /文件夹|路径|目录/);
  }
  assert.equal(calls.length, 0);
});

test('打开自定义目录必须使用存在的文件夹卡片，旧数据目录卡片仍能打开', { skip: process.platform !== 'win32' }, async t => {
  const { calls } = explorerStub(t);
  const { url, dir } = await app(t);
  const state = await (await fetch(url + '/api/state')).json(); const task = state.tasks[0];
  const post = target => fetch(url + '/api/open-folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(target) });
  assert.equal((await post({taskId:task.id,cardId:'missing'})).status, 404);
  assert.equal((await post({taskId:task.id,cardId:task.nodes.find(node=>node.type==='markdown').id})).status, 400);
  assert.equal(calls.length, 0);
  const legacy = task.nodes.find(node=>node.localFolder);
  assert.equal((await post({taskId:task.id,cardId:legacy.id})).status, 200);
  assert.deepEqual(calls[0].args, [dir]);
});

test('打开指定目录后按完整路径请求前台显示，路径仅通过环境变量传递', { skip: process.platform !== 'win32' }, async t => {
  const { calls, focusCalls } = explorerStub(t);
  const { url, dir } = await app(t);
  const folder = path.join(dir, "资料 & 项目; '中文 空格"); await mkdir(folder);
  const target = await saveFolderCard(url, folder);
  const response = await fetch(url+'/api/open-folder',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(target)});
  assert.equal(response.status,200);
  assert.equal((await response.json()).foreground,true);
  assert.equal(calls.length,1); assert.equal(focusCalls.length,1);
  assert.equal(focusCalls[0].options.env.WORKDESK_FOCUS_FOLDER,folder);
  assert.equal(focusCalls[0].args.includes(folder),false);
  assert.equal(focusCalls[0].args.includes('-Command'),false);
  assert.equal(focusCalls[0].options.windowsHide,true);
  assert.ok(focusCalls[0].options.timeout>0 && focusCalls[0].options.timeout<=10000);
});

test('前台激活被拒绝或辅助程序失败时仍保留已打开结果，并返回未激活状态', { skip: process.platform !== 'win32' }, async t => {
  const fixture = await app(t);
  for (const focusFails of [false,true]) {
    const { calls, focusCalls } = explorerStub(t,{foreground:false,focusFails});
    const response = await fetch(fixture.url+'/api/open-folder',{method:'POST'});
    assert.equal(response.status,200);
    assert.equal((await response.json()).foreground,false);
    assert.equal(calls.length,1); assert.equal(focusCalls.length,1);
    t.mock.restoreAll(); syncBuiltinESMExports();
  }
});
