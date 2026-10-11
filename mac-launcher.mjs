import {spawn,execFile} from 'node:child_process';
import {open,readFile,writeFile,unlink,access,stat} from 'node:fs/promises';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const exec=promisify(execFile);
const root=path.dirname(fileURLToPath(import.meta.url));
const serverFile=path.join(root,'server.mjs');
const pidFile=path.join(root,'.server.pid');
const lockFile=path.join(root,'.server.start.lock');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const exists=file=>access(file).then(()=>true,()=>false);
const expectedCommand=process.execPath+' '+serverFile;

async function processIdentity(pid) {
  if(!Number.isInteger(pid)||pid<2)return null;
  try {
    const [command,started]=await Promise.all([
      exec('/bin/ps',['-ww','-p',String(pid),'-o','command='],{timeout:2000}),
      exec('/bin/ps',['-p',String(pid),'-o','lstart='],{timeout:2000})
    ]);
    return {command:command.stdout.trim(),started:started.stdout.trim()};
  } catch {return null;}
}

async function managedProcess() {
  let saved;
  try {saved=JSON.parse(await readFile(pidFile,'utf8'));}catch{return null;}
  const current=await processIdentity(saved.pid);
  // Check the complete command and creation time before signalling a PID.
  // A stale PID or a server in another checkout must never be stopped.
  if(current?.command!==expectedCommand||saved.command!==expectedCommand||current.started!==saved.started)return null;
  return saved;
}

async function health(url) {
  try {
    const response=await fetch(url+'/api/health',{signal:AbortSignal.timeout(1000)});
    if(!response.ok)return false;
    const value=await response.json();
    return value.app==='workdesk-local'&&value.status==='ok';
  }catch{return false;}
}

async function showBrowser(url) {
  if(process.env.WORKDESK_NO_BROWSER==='1')return;
  try {await exec('/usr/bin/open',[url],{timeout:10000});}
  catch {console.log('浏览器未能自动打开，请访问：'+url);}
}

async function installDependencies() {
  const missing=await Promise.all(['@modelcontextprotocol/sdk','zod'].map(name=>exists(path.join(root,'node_modules',name,'package.json'))));
  if(missing.every(Boolean))return;
  console.log('首次启动正在安装依赖，需要联网，请稍候……');
  const log=await open(path.join(root,'install.log'),'w');
  try {
    await new Promise((resolve,reject)=>{
      const child=spawn('npm',['ci','--no-audit','--no-fund'],{cwd:root,stdio:['ignore',log.fd,log.fd]});
      child.once('error',reject);
      child.once('exit',code=>code===0?resolve():reject(new Error('npm exit '+code)));
    });
  }catch {throw new Error('依赖安装失败，请检查 Node.js 附带的 npm、网络或 npm 镜像后重试。详细信息：'+path.join(root,'install.log'));}
  finally {await log.close();}
}

async function start() {
  const port=Number(process.env.WORKDESK_PORT||4317);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('WORKDESK_PORT 必须为 1 到 65535 之间的端口号。');
  const url='http://127.0.0.1:'+port;
  const existing=await managedProcess();
  if(await health(url)) {
    if(!existing||existing.port!==port)throw new Error('端口 '+port+' 已由其他目录或手动启动的工作台使用，本目录尚未启动。请停止原服务，或设置其他 WORKDESK_PORT。');
    await showBrowser(url);
    console.log('本地工作台已打开：'+url);
    return;
  }
  if(existing)throw new Error('本目录的后台服务仍在运行，请先运行 stop.command，再重新启动。');
  await installDependencies();
  const output=await open(path.join(root,'server.log'),'w');
  const errors=await open(path.join(root,'server-error.log'),'w');
  let child;
  try {
    child=spawn(process.execPath,[serverFile],{cwd:root,env:{...process.env,WORKDESK_PORT:String(port)},detached:true,stdio:['ignore',output.fd,errors.fd]});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  } finally {await output.close();await errors.close();}
  child.unref();
  try {
    const identity=await processIdentity(child.pid);
    if(identity?.command!==expectedCommand)throw new Error('后台服务未能启动。');
    await writeFile(pidFile,JSON.stringify({pid:child.pid,...identity,port})+'\n',{mode:0o600});
    console.log('正在启动本地工作台，请稍候……');
    const deadline=Date.now()+30000;
    while(Date.now()<deadline) {
      if(child.exitCode!==null||child.signalCode!==null)break;
      if(await health(url)) {
        await showBrowser(url);
        console.log('本地工作台已打开：'+url);
        return;
      }
      await delay(200);
    }
    throw new Error('后台服务启动失败，请查看本目录的 server-error.log（也请检查端口是否被占用）。');
  }catch(error) {
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
    await unlink(pidFile).catch(()=>{});
    throw error;
  }
}

async function startOnce() {
  let lock;
  try {lock=await open(lockFile,'wx',0o600);}
  catch(error) {
    if(error.code!=='EEXIST')throw error;
    let owner;
    try {owner=JSON.parse(await readFile(lockFile,'utf8'));}catch{}
    const identity=owner&&await processIdentity(owner.pid);
    const creating=!owner&&Date.now()-(await stat(lockFile)).mtimeMs<30000;
    if(creating||(identity&&identity.command===owner.command&&identity.started===owner.started)) {
      console.log('本地工作台正在启动，请等待第一个启动窗口完成。');
      return;
    }
    await unlink(lockFile);
    lock=await open(lockFile,'wx',0o600);
  }
  try {
    await lock.writeFile(JSON.stringify({pid:process.pid,...await processIdentity(process.pid)}));
    await start();
  } finally {await lock.close();await unlink(lockFile).catch(()=>{});}
}

async function stop() {
  const saved=await managedProcess();
  if(!saved) {
    await unlink(pidFile).catch(()=>{});
    console.log('没有找到由本目录启动的后台服务。通过 npm start 启动的服务请在原终端按 Ctrl + C 停止。');
    return;
  }
  try {process.kill(saved.pid,'SIGTERM');}
  catch(error) {if(error.code!=='ESRCH')throw error;}
  const deadline=Date.now()+5000;
  while(Date.now()<deadline) {
    if(!await managedProcess()) {
      await unlink(pidFile).catch(()=>{});
      console.log('本地工作台已停止，数据保留在 data 文件夹。');
      return;
    }
    await delay(100);
  }
  throw new Error('服务尚未退出，请稍后重试；没有强制终止进程。');
}

try {
  if(Number(process.versions.node.split('.')[0])<22)throw new Error('需要 Node.js 22 或更新版本，请安装后重新启动。');
  if(process.argv[2]==='start')await startOnce();
  else if(process.argv[2]==='stop')await stop();
  else throw new Error('请通过 start.command 或 stop.command 运行。');
}catch(error) {console.error('操作失败：'+error.message);process.exitCode=1;}
