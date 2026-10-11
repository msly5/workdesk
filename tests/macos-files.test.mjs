import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile,chmod,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import {EventEmitter} from 'node:events';
import {syncBuiltinESMExports} from 'node:module';
import {normalizeLocalPath} from '../local-files.mjs';

const mac={skip:process.platform!=='darwin'};
test('本机路径按系统校验，拒绝相对路径、URL、网络路径和控制字符',()=>{
  assert.equal(normalizeLocalPath(' "/Users/your-name/资料 中文/report.txt" ','文件','darwin'),'/Users/your-name/资料 中文/report.txt');
  assert.equal(normalizeLocalPath(' "D:/资料/报告.txt" ','文件','win32'),'D:\\资料\\报告.txt');
  for(const value of ['relative','~/Documents','file:///Users/your-name','https://example.org','//server/share','\\\\server\\share','/Users/a\nfile']) {
    assert.throws(()=>normalizeLocalPath(value,'文件','darwin'),/完整.*路径/);
  }
  assert.throws(()=>normalizeLocalPath('/Users/your-name/file','文件','win32'),/完整.*路径/);
  assert.throws(()=>normalizeLocalPath('C:\\资料\\报告.txt','文件','darwin'),/完整.*路径/);
});

async function fixture(t,{fails=false,pending=false}={}) {
  const calls=[];
  const original=childProcess.execFile;
  t.mock.method(childProcess,'execFile',(file,args,options,callback)=>{
    if(file!=='/usr/bin/open')return original(file,args,options,callback);
    calls.push({file,args,options,finish:()=>callback(fails?new Error('open unavailable'):null,'','')});
    if(!pending)queueMicrotask(calls.at(-1).finish);
    return new EventEmitter();
  });
  syncBuiltinESMExports();
  const {createApp}=await import('../server.mjs');
  const dir=await mkdtemp(path.join(tmpdir(),'workdesk-mac-中文 空格-'));
  const server=await createApp({dataDir:dir});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{
    await new Promise(resolve=>server.close(resolve));
    t.mock.restoreAll();syncBuiltinESMExports();
    await rm(dir,{recursive:true,force:true});
  });
  const url='http://127.0.0.1:'+server.address().port;
  const post=(route,data,headers={})=>fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(data)});
  async function saveCard(fields) {
    const state=await (await fetch(url+'/api/state')).json(),task=state.tasks[0];
    const card={id:'mac-card',type:'file',title:'Mac 文件',content:'',x:0,y:0,width:310,...fields};
    task.nodes=task.nodes.filter(node=>node.id!==card.id);task.nodes.push(card);
    const saved=await fetch(url+'/api/state',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(state)});
    assert.equal(saved.status,200);
    return {taskId:task.id,cardId:card.id};
  }
  return {url,dir,calls,post,saveCard};
}

test('macOS 默认程序打开原文件，Finder 定位保留特殊字符并不执行 shell',mac,async t=>{
  const {dir,calls,post,saveCard}=await fixture(t);
  const file=path.join(dir,"原文件 中文 & ; $(touch nope) ' , 空格.txt");
  await writeFile(file,'原文件');
  const target=await saveCard({localFile:true,filePath:' "'+file+'" '});
  assert.equal((await post('/api/file-action',{...target,action:'open'})).status,200);
  assert.deepEqual(calls[0].args,[file]);assert.equal(calls[0].options.shell,undefined);
  assert.equal((await post('/api/file-action',{...target,action:'reveal'})).status,200);
  assert.deepEqual(calls[1].args,['-R',file]);
  assert.equal((await post('/api/file-action',{...target,action:'open'},{Origin:'https://example.org'})).status,403);
  assert.equal(calls.length,2);
});

test('macOS 附件打开带扩展名副本，外部编辑后下载读取同一份文件',mac,async t=>{
  const {url,calls,post,saveCard}=await fixture(t);
  const state=await (await fetch(url+'/api/state')).json();
  const asset=await (await fetch(url+'/api/files?taskId='+state.tasks[0].id+'&name='+encodeURIComponent('报告 中文.md'),{method:'POST',body:'原内容'})).json();
  const target=await saveCard({assetId:asset.id});
  assert.equal((await post('/api/file-action',{...target,action:'open'})).status,200);
  const file=calls[0].args[0];assert.equal(path.extname(file),'.md');assert.ok(file.includes(asset.id));
  await writeFile(file,'外部编辑');
  assert.equal(await (await fetch(url+'/api/files/'+asset.id)).text(),'外部编辑');
});

test('macOS 程序、安装包、脚本和可执行文件仅允许定位，错误卡片及非法路径不调用系统',mac,async t=>{
  const {dir,calls,post,saveCard}=await fixture(t);
  for(const name of ['.command','安装.pkg','安装.dmg','脚本.sh','脚本.scpt','脚本.mjs','脚本.cmd','脚本.py','可执行.txt']) {
    const file=path.join(dir,name);await writeFile(file,'test');
    if(name==='可执行.txt')await chmod(file,0o755);
    const target=await saveCard({localFile:true,filePath:file});
    assert.equal((await post('/api/file-action',{...target,action:'open'})).status,400,name);
    assert.equal(calls.length,0);
  }
  for(const [filePath,status] of [['relative.txt',400],[dir,400],[path.join(dir,'missing.txt'),404]]) {
    const target=await saveCard({localFile:true,filePath});
    assert.equal((await post('/api/file-action',{...target,action:'open'})).status,status);
  }
  const alias=path.join(dir,'script-link.txt');await symlink(path.join(dir,'脚本.sh'),alias);
  const linked=await saveCard({localFile:true,filePath:alias});
  assert.equal((await post('/api/file-action',{...linked,action:'open'})).status,400);
  assert.equal((await post('/api/file-action',{path:'/bin/sh',action:'open'})).status,400);
  const target=await saveCard({localFile:true,filePath:path.join(dir,'脚本.sh')});
  assert.equal((await post('/api/file-action',{...target,action:'reveal'})).status,200);
  assert.deepEqual(calls[0].args,['-R',path.join(dir,'脚本.sh')]);
});

test('macOS 文件夹卡片和数据目录明确交由 Finder 打开，应用包不被运行',mac,async t=>{
  const {dir,calls,post,saveCard}=await fixture(t);
  const folder=path.join(dir,'资料 中文 & ;');await mkdir(folder);
  const target=await saveCard({type:'link',localFolder:true,folderPath:folder});
  const response=await post('/api/open-folder',target);
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true});
  assert.deepEqual(calls[0].args,['-b','com.apple.finder',folder]);
  assert.equal((await post('/api/open-folder',{})).status,200);
  assert.deepEqual(calls[1].args,['-b','com.apple.finder',dir]);
  assert.equal((await post('/api/open-folder',target,{Origin:'https://example.org'})).status,403);
  for(const folderPath of ['', 'relative', '//server/share', '/missing-workdesk-folder']) {
    const invalid=await saveCard({type:'link',localFolder:true,folderPath});
    assert.ok((await post('/api/open-folder',invalid)).status>=400);
  }
  assert.equal(calls.length,2);
  const bundle=path.join(dir,'应用.app');await mkdir(bundle);
  const packageTarget=await saveCard({type:'link',localFolder:true,folderPath:bundle});
  assert.equal((await post('/api/open-folder',packageTarget)).status,200);
  assert.deepEqual(calls[2].args,['-R',bundle]);
});

test('macOS 系统拒绝打开时返回失败及可手动访问的路径',mac,async t=>{
  const {dir,post,saveCard}=await fixture(t,{fails:true});
  const file=path.join(dir,'报告.txt');await writeFile(file,'内容');
  const target=await saveCard({localFile:true,filePath:file});
  const response=await post('/api/file-action',{...target,action:'open'});
  assert.equal(response.status,500);assert.ok((await response.json()).error.includes(file));
  const folder=await post('/api/open-folder',{});
  assert.equal(folder.status,500);assert.ok((await folder.json()).error.includes(dir));
});

test('macOS 等待 open 命令成功退出后才报告完成',mac,async t=>{
  const {calls,post}=await fixture(t,{pending:true});
  let settled=false;
  const request=post('/api/open-folder',{}).then(response=>{settled=true;return response;});
  while(!calls.length)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(settled,false);
  calls[0].finish();
  assert.equal((await request).status,200);
});
