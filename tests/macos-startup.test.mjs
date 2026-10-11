import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,copyFile,mkdir,mkdtemp,rm,access} from 'node:fs/promises';
import {spawnSync,spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const mac={skip:process.platform!=='darwin'};
const exists=file=>access(file).then(()=>true,()=>false);
async function fixture(t,{installFails=false,readyDelay=0}={}) {
  const dir=await mkdtemp(path.join(tmpdir(),'workdesk-mac-start-中文 空格-'));
  await mkdir(path.join(dir,'bin'));
  for(const name of ['start.command','stop.command','mac-launcher.mjs','package.json','package-lock.json'])await copyFile(path.join(root,name),path.join(dir,name));
  await writeFile(path.join(dir,'server.mjs'),`import http from 'node:http';const readyAt=Date.now()+${readyDelay};http.createServer((req,res)=>{res.statusCode=Date.now()<readyAt?503:200;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({app:'workdesk-local',status:'ok'}));}).listen(Number(process.env.WORKDESK_PORT),'127.0.0.1');`);
  await writeFile(path.join(dir,'bin','npm'),'#!/bin/bash\nexec "$WORKDESK_TEST_NODE" "$(dirname "$0")/install.mjs" "$@"\n',{mode:0o755});
  await writeFile(path.join(dir,'bin','install.mjs'),"import {mkdir,writeFile} from 'node:fs/promises';await writeFile('install-called.txt',JSON.stringify(process.argv.slice(2)));if(process.env.WORKDESK_TEST_INSTALL_FAIL==='1')process.exit(9);for(const p of ['@modelcontextprotocol/sdk','zod']){await mkdir('node_modules/'+p,{recursive:true});await writeFile('node_modules/'+p+'/package.json','{}');}");
  const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const env={...process.env,PATH:path.join(dir,'bin')+':'+path.dirname(process.execPath)+':'+process.env.PATH,WORKDESK_NO_BROWSER:'1',WORKDESK_TEST_NODE:process.execPath,WORKDESK_PORT:String(port),WORKDESK_TEST_INSTALL_FAIL:installFails?'1':'0'};
  const run=action=>spawnSync('/bin/bash',[path.join(dir,action+'.command')],{env,cwd:tmpdir(),encoding:'utf8',timeout:35000});
  const runAsync=action=>new Promise((resolve,reject)=>{
    const child=spawn('/bin/bash',[path.join(dir,action+'.command')],{env,cwd:tmpdir(),stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value);
    child.once('error',reject);child.once('close',status=>resolve({status,stdout,stderr}));
  });
  t.after(async()=>{
    const stopped=run('stop');assert.equal(stopped.status,0,stopped.stdout+stopped.stderr);
    assert.ok(path.resolve(dir).startsWith(path.resolve(tmpdir())+path.sep));
    await rm(dir,{recursive:true,force:true});
  });
  return {dir,port,run,runAsync,env};
}

test('macOS 双击入口安装依赖，在中文空格目录启动、复用、停止后台服务',mac,async t=>{
  const {dir,port,run}=await fixture(t,{readyDelay:800});
  const launched=run('start');assert.equal(launched.status,0,launched.stdout+launched.stderr);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir,'install-called.txt'),'utf8')),['ci','--no-audit','--no-fund']);
  assert.equal((await (await fetch('http://127.0.0.1:'+port+'/api/health')).json()).status,'ok');
  const saved=await readFile(path.join(dir,'.server.pid'),'utf8');
  await writeFile(path.join(dir,'install-called.txt'),'already-installed');
  const repeated=run('start');assert.equal(repeated.status,0,repeated.stdout+repeated.stderr);
  assert.equal(await readFile(path.join(dir,'install-called.txt'),'utf8'),'already-installed');
  assert.equal(await readFile(path.join(dir,'.server.pid'),'utf8'),saved);
  const stopped=run('stop');assert.equal(stopped.status,0,stopped.stdout+stopped.stderr);
  assert.equal(await exists(path.join(dir,'.server.pid')),false);
  await assert.rejects(fetch('http://127.0.0.1:'+port+'/api/health',{signal:AbortSignal.timeout(1000)}));
});

test('macOS 安装失败不留下服务 PID，并给出安装日志位置',mac,async t=>{
  const {dir,run}=await fixture(t,{installFails:true});
  const result=run('start');assert.equal(result.status,1);
  assert.match(result.stderr,/依赖安装失败/);assert.match(result.stderr,/install\.log/);
  assert.equal(await exists(path.join(dir,'.server.pid')),false);
});

test('macOS 停止入口拒绝陈旧或伪造 PID，不结束其他进程',mac,async t=>{
  const {dir,run}=await fixture(t);
  const unrelated=spawn('/bin/sleep',['60'],{stdio:'ignore'});
  t.after(()=>unrelated.kill());
  await new Promise((resolve,reject)=>{unrelated.once('spawn',resolve);unrelated.once('error',reject);});
  await writeFile(path.join(dir,'.server.pid'),JSON.stringify({pid:unrelated.pid,command:process.execPath+' '+path.join(dir,'server.mjs'),started:'not this process'}));
  const stopped=run('stop');assert.equal(stopped.status,0,stopped.stdout+stopped.stderr);
  assert.doesNotThrow(()=>process.kill(unrelated.pid,0));
  assert.equal(await exists(path.join(dir,'.server.pid')),false);
});

test('macOS 重复启动等待首个启动器，保留可停止的同一后台服务',mac,async t=>{
  const {dir,port,runAsync}=await fixture(t,{readyDelay:500});
  const results=await Promise.all([runAsync('start'),runAsync('start')]);
  for(const result of results)assert.equal(result.status,0,result.stdout+result.stderr);
  assert.ok(results.some(result=>result.stdout.includes('正在启动，请等待')));
  assert.equal((await (await fetch('http://127.0.0.1:'+port+'/api/health')).json()).status,'ok');
  assert.equal(await exists(path.join(dir,'.server.pid')),true);
  assert.equal(await exists(path.join(dir,'.server.start.lock')),false);
});

test('macOS 不把同端口其他或手动启动的 Workdesk 误认为本目录已启动',mac,async t=>{
  const {dir,runAsync,env}=await fixture(t);
  const foreign=spawn(process.execPath,[path.join(dir,'server.mjs')],{env,stdio:'ignore'});
  t.after(()=>foreign.kill());
  await new Promise((resolve,reject)=>{foreign.once('spawn',resolve);foreign.once('error',reject);});
  const url='http://127.0.0.1:'+env.WORKDESK_PORT+'/api/health';
  const deadline=Date.now()+5000;
  while(Date.now()<deadline) {
    try {if((await fetch(url)).ok)break;}catch{}
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  const result=await runAsync('start');
  assert.equal(result.status,1,result.stdout+result.stderr);assert.match(result.stderr,/其他目录或手动启动/);
  assert.equal(await exists(path.join(dir,'.server.pid')),false);
  assert.doesNotThrow(()=>process.kill(foreign.pid,0));
});
