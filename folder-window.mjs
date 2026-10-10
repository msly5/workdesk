import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const script=fileURLToPath(new URL('./focus-folder.ps1',import.meta.url));
export function focusFolder(folder) {
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
