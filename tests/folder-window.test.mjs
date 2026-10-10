import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const quote=value=>"'"+value.replaceAll("'","''")+"'";
test('前台助手兼容 PowerShell 5.1，仅匹配完整目录，且原生接口能够编译', {skip:process.platform!=='win32'}, async t=>{
  const script=path.join(ROOT,'focus-folder.ps1');
  await readFile(script); // Fail if the runtime helper has not been provided.
  const dir=await mkdtemp(path.join(tmpdir(),'workdesk-focus-test-'));
  t.after(async()=>{
    assert.ok(path.resolve(dir).startsWith(path.resolve(tmpdir())+path.sep));
    await rm(dir,{recursive:true,force:true});
  });
  const checks=path.join(dir,'checks.ps1');
  await writeFile(checks,'\ufeff'+`
$ErrorActionPreference='Stop'
$tokens=$null; $parseErrors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile(${quote(script)},[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw 'Helper syntax failed'}
# Load pure matching functions without running desktop automation.
foreach($definition in $ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst]},$false)){
  Invoke-Expression $definition.Extent.Text
}
function Fake-Window([string]$folder,[long]$handle,[string]$exe='C:\\Windows\\explorer.exe'){
  [pscustomobject]@{FullName=$exe;HWND=$handle;Document=[pscustomobject]@{Folder=[pscustomobject]@{Self=[pscustomobject]@{Path=$folder}}}}
}
$windows=@((Fake-Window 'D:\\other\\project' 1),(Fake-Window 'D:\\资料 中文\\project' 42))
if((Find-WorkdeskFolderWindow $windows 'd:/资料 中文/project/').ToInt64() -ne 42){throw 'Wrong folder with same name was selected'}
if((Find-WorkdeskFolderWindow $windows 'D:\\missing\\project').ToInt64() -ne 0){throw 'Partial folder match was accepted'}
if((Find-WorkdeskFolderWindow @((Fake-Window 'D:\\' 8)) 'd:/').ToInt64() -ne 8){throw 'Drive root failed'}
if((Find-WorkdeskFolderWindow @((Fake-Window 'D:\\project' 9 'C:\\chrome.exe')) 'D:\\project').ToInt64() -ne 0){throw 'Non Explorer window was accepted'}
$closed=[pscustomobject]@{FullName='C:\\Windows\\explorer.exe';HWND=4}
$closed | Add-Member -MemberType ScriptProperty -Name Document -Value {throw 'Closed during enumeration'}
if((Find-WorkdeskFolderWindow @($closed,(Fake-Window 'D:\\project' 10)) 'D:\\project').ToInt64() -ne 10){throw 'Closed window interrupted matching'}
Add-Type -Path ${quote(path.join(ROOT,'folder-window.cs'))}
if(-not ('WorkdeskFolderForeground' -as [type])){throw 'Native helper failed to compile'}
$script:focusChecks=0
$eventual=[Func[bool]]{ $script:focusChecks++; return $script:focusChecks -ge 3 }
if(-not [WorkdeskFolderForeground]::WaitForForeground($eventual,200)){throw 'Delayed foreground acknowledgement failed'}
$never=[Func[bool]]{ return $false }
if([WorkdeskFolderForeground]::WaitForForeground($never,40)){throw 'Denied foreground was reported as success'}
Write-Output 'matching-and-compile-ok'
`);
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-File',checks],{encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
  assert.match(result.stdout,/matching-and-compile-ok/);
});
