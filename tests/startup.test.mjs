import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, copyFile, mkdir, mkdtemp, rm, access } from 'node:fs/promises';
import { openSync, closeSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const windows=process.platform==='win32';
const quote=value=>"'"+value.replaceAll("'","''")+"'";
function powershell(script,options={}) {
  const prefix="$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); ";
  return spawnSync('powershell.exe',['-NoProfile','-OutputFormat','Text','-EncodedCommand',Buffer.from(prefix+script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:30000,...options});
}
test('Windows PowerShell 5.1 能解析含中文的启动和停止脚本', {skip:!windows},()=>{
  for(const name of ['start.ps1','stop.ps1']) {
    const result=powershell('$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile('+quote(path.join(ROOT,name))+',[ref]$tokens,[ref]$errors)|Out-Null; @($errors|ForEach-Object {$_.Message})|ConvertTo-Json -Compress');
    assert.equal(result.status,0,result.stderr);
    assert.ok(!result.stdout.trim() || result.stdout.trim()==='[]',name+': '+result.stdout);
  }
});

async function fixture(t,installFails=false,readyDelay=0) {
  const dir=await mkdtemp(path.join(tmpdir(),'workdesk-startup-中文 空格-'));
  assert.ok(path.resolve(dir).startsWith(path.resolve(tmpdir())+path.sep));
  await mkdir(path.join(dir,'bin'));
  for(const name of ['start.cmd','start.ps1','stop.ps1','package.json','package-lock.json'])await copyFile(path.join(ROOT,name),path.join(dir,name));
  await writeFile(path.join(dir,'server.mjs'),"import http from 'node:http';const readyAt=Date.now()+"+readyDelay+";http.createServer((req,res)=>{res.statusCode=Date.now()<readyAt?503:200;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({app:'workdesk-local',status:'ok'}));}).listen(Number(process.env.WORKDESK_PORT),'127.0.0.1');");
  // Replace only the network installer. Run the real Windows launcher and a real server.
  await writeFile(path.join(dir,'bin','npm.cmd'),'@echo off\r\n"'+process.execPath+'" "%~dp0install.mjs" %*\r\nexit /b %errorlevel%\r\n');
  await writeFile(path.join(dir,'bin','install.mjs'),"import {mkdir,writeFile} from 'node:fs/promises';await writeFile('install-called.txt',JSON.stringify(process.argv.slice(2)));if(process.env.WORKDESK_TEST_INSTALL_FAIL==='1')process.exit(9);for(const p of ['@modelcontextprotocol/sdk','zod']){await mkdir('node_modules/'+p,{recursive:true});await writeFile('node_modules/'+p+'/package.json','{}');}");
  const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const env={...process.env,WORKDESK_NO_BROWSER:'1',WORKDESK_PORT:String(port),WORKDESK_TEST_INSTALL_FAIL:installFails?'1':'0'};
  const pathKey=Object.keys(env).find(key=>key.toLowerCase()==='path') || 'PATH';
  env[pathKey]=path.join(dir,'bin')+path.delimiter+process.env.PATH;
  t.after(async()=>{
    powershell('& '+quote(path.join(dir,'stop.ps1')),{env});
    // The only recursive removal is the resolved, newly created test directory.
    assert.ok(path.resolve(dir).startsWith(path.resolve(tmpdir())+path.sep));
    await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  });
  return {dir,port,run:()=>{
    // A background Windows process can inherit pipe handles from CMD. Use files
    // so the test waits for the launcher, rather than for the server to exit.
    const out=path.join(dir,'cmd-output.log'),err=path.join(dir,'cmd-error.log');
    const outFd=openSync(out,'w'),errFd=openSync(err,'w');
    let result;
    try {
      result=spawnSync('cmd.exe',['/d','/s','/c','""'+path.join(dir,'start.cmd')+'""'],{env,cwd:tmpdir(),windowsHide:true,windowsVerbatimArguments:true,stdio:['ignore',outFd,errFd],timeout:30000});
    } finally { closeSync(outFd);closeSync(errFd); }
    return {...result,stdout:readFileSync(out,'utf8'),stderr:readFileSync(err,'utf8')};
  }};
}
test('新电脑双击启动前自动安装缺失依赖，支持中文和空格路径', {skip:!windows},async t=>{
  const {dir,port,run}=await fixture(t);
  const result=run();
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
  assert.ok(await access(path.join(dir,'install-called.txt')).then(()=>true,()=>false),'首次启动没有执行依赖安装');
  assert.deepEqual(JSON.parse(await readFile(path.join(dir,'install-called.txt'),'utf8')),['ci','--no-audit','--no-fund']);
  assert.deepEqual(await (await fetch('http://127.0.0.1:'+port+'/api/health')).json(),{app:'workdesk-local',status:'ok'});
  // Once ready, the second launch must reuse the server and not rerun installation.
  await writeFile(path.join(dir,'install-called.txt'),'already-installed');
  assert.equal(run().status,0);
  assert.equal(await readFile(path.join(dir,'install-called.txt'),'utf8'),'already-installed');
});
test('依赖安装失败时停止启动并给出简洁错误，不留下后台服务', {skip:!windows},async t=>{
  const {dir,run}=await fixture(t,true);
  const result=run();
  assert.equal(result.status,1);
  assert.match(result.stdout,/依赖安装失败/);
  assert.equal(result.stderr.trim(),'');
  assert.equal(await access(path.join(dir,'.server.pid')).then(()=>true,()=>false),false);
});

test('后台服务较慢就绪时继续等待，不会被过早终止', {skip:!windows},async t=>{
  const {port,run}=await fixture(t,false,8000);
  const result=run();
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
  assert.deepEqual(await (await fetch('http://127.0.0.1:'+port+'/api/health')).json(),{app:'workdesk-local',status:'ok'});
});
