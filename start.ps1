$ErrorActionPreference = 'Stop'
$workdeskPort = if ($env:WORKDESK_PORT) { [int]$env:WORKDESK_PORT } else { 4317 }
$workdeskUrl = "http://127.0.0.1:$workdeskPort"
try {
    $workdeskHealth = Invoke-RestMethod "$workdeskUrl/api/health" -TimeoutSec 2
    if ($workdeskHealth.app -ne 'workdesk-local') { throw '端口被其他程序使用' }
    if ($env:WORKDESK_NO_BROWSER -ne '1') { Start-Process $workdeskUrl }
    Write-Host "本地工作台已打开：$workdeskUrl"
    exit 0
} catch {}
$workdeskNode = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $workdeskNode) { throw '需要 Node.js 22 或更新版本。安装后再双击启动。' }
$workdeskServer = Join-Path $PSScriptRoot 'server.mjs'
$workdeskProcess = Start-Process -FilePath $workdeskNode.Source -ArgumentList ('"' + $workdeskServer + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $PSScriptRoot 'server.log') -RedirectStandardError (Join-Path $PSScriptRoot 'server-error.log')
$workdeskProcess.Id | Set-Content -LiteralPath (Join-Path $PSScriptRoot '.server.pid')
for ($workdeskTry = 0; $workdeskTry -lt 30; $workdeskTry++) {
    Start-Sleep -Milliseconds 200
    try {
        $workdeskHealth = Invoke-RestMethod "$workdeskUrl/api/health" -TimeoutSec 1
        if ($workdeskHealth.app -eq 'workdesk-local') {
            if ($env:WORKDESK_NO_BROWSER -ne '1') { Start-Process $workdeskUrl }
            Write-Host "本地工作台已打开：$workdeskUrl"
            exit 0
        }
    } catch {}
}
Write-Host '启动未成功，请查看 server-error.log。'
exit 1
