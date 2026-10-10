import {execFile,spawn} from 'node:child_process';
import {stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {AppError} from './storage.mjs';
import {focusFolder} from './folder-window.mjs';

const script=fileURLToPath(new URL('./open-file.ps1',import.meta.url));
const programs=new Set(['.exe','.com','.bat','.cmd','.ps1','.psm1','.vbs','.vbe','.js','.jse','.wsf','.wsh','.msi','.msp','.scr','.cpl','.lnk','.url','.hta','.reg','.py','.pyw','.pif','.scf','.msc','.application','.appref-ms']);
export async function localFilePath(value) {
  if(typeof value!=='string')throw new AppError('请先填写文件的完整路径。');
  let file=value.trim();
  if(file.startsWith('"')&&file.endsWith('"'))file=file.slice(1,-1).trim();
  if(!file || !/^[a-z]:[\\/]/i.test(file) || /[\u0000-\u001f<>:"|?*]/.test(file.slice(2)))throw new AppError('请填写本机完整文件路径，例如 D:\\资料\\报告.docx。');
  file=path.win32.normalize(file);
  await requireFile(file); return file;
}
async function requireFile(file) {
  let info;
  try {info=await stat(file);}
  catch(error) {
    if(error.code==='ENOENT'||error.code==='ENOTDIR')throw new AppError('文件不存在或已移动，请检查路径：'+file,404);
    throw new AppError('无法访问文件，请检查权限：'+file,403);
  }
  if(!info.isFile())throw new AppError('该路径不是文件，请填写完整文件路径。');
}
export async function actOnFile(file,action) {
  await requireFile(file);
  if(action==='reveal') {
    try {
      await new Promise((resolve,reject)=>{
        // Explorer uses commas as delimiters. Always quote the full path, even
        // without spaces, and keep Node from escaping those literal quotes.
        const child=spawn('explorer.exe',['/select,','"'+file+'"'],{windowsVerbatimArguments:true,windowsHide:false,detached:true,stdio:'ignore'});
        child.once('error',reject); child.once('spawn',()=>{child.unref();resolve();});
      });
    } catch {throw new AppError('无法打开所在文件夹，请手动定位：'+file,500);}
    return {ok:true,foreground:await focusFolder(path.dirname(file))};
  }
  // Windows treats a dot-only stem as an extension and ignores trailing dots/spaces.
  const name=path.win32.basename(file).replace(/[. ]+$/g,'').toLowerCase();
  const dot=name.lastIndexOf('.');
  if(programs.has(dot<0?'':name.slice(dot)))throw new AppError('此类型可能运行程序，请通过“打开所在文件夹”自行查看。');
  const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  await new Promise((resolve,reject)=>{
    execFile(powershell,['-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',script],{
      windowsHide:true,timeout:10000,maxBuffer:16384,env:{...process.env,WORKDESK_OPEN_FILE:file}
    },error=>error?reject(new AppError('无法用默认程序打开文件，请检查文件关联，或使用“打开所在文件夹”：'+file,500)):resolve());
  });
  return {ok:true};
}
