import {execFile,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {realpath} from 'node:fs/promises';
import {AppError} from './storage.mjs';

const script=fileURLToPath(new URL('./focus-folder.ps1',import.meta.url));
export async function openFolder(folder) {
  if(process.platform==='darwin') {
    const resolved=await realpath(folder);
    const packageFolder=/\.(app|workflow|scptd|action|bundle|plugin|kext|prefpane)$/i.test(resolved);
    await new Promise((resolve,reject)=>{
      // Reveal application bundles rather than asking Finder to open a package.
      execFile('/usr/bin/open',packageFolder?['-R',folder]:['-b','com.apple.finder',folder],{timeout:10000,maxBuffer:16384},error=>error?reject(new AppError('无法打开 Finder，请手动打开文件夹：'+folder,500)):resolve());
    });
    return {ok:true};
  }
  if(process.platform!=='win32')throw new AppError('直接打开文件夹目前支持 Windows 和 macOS。');
  try {
    await new Promise((resolve,reject)=>{
      const child=spawn('explorer.exe',[folder],{windowsHide:false,detached:true,stdio:'ignore'});
      child.once('error',reject);
      child.once('spawn',()=>{child.unref();resolve();});
    });
  } catch {throw new AppError('无法启动资源管理器，请手动打开文件夹：'+folder,500);}
  return {ok:true,foreground:await focusFolder(folder)};
}
export function focusFolder(folder) {
  if(process.platform!=='win32')return Promise.resolve(false);
  const powershell=path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  return new Promise(resolve=>{
    execFile(powershell,['-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',script],{
      windowsHide:true,timeout:7000,maxBuffer:16384,encoding:'utf8',
      env:{...process.env,WORKDESK_FOCUS_FOLDER:folder}
    },(error,stdout)=>{
      if(error)return resolve(false);
      try {resolve(JSON.parse(stdout.trim()).foreground===true);}
      catch {resolve(false);}
    });
  });
}
