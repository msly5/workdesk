$workdeskPidFile = Join-Path $PSScriptRoot '.server.pid'
if (Test-Path -LiteralPath $workdeskPidFile) {
    $workdeskPid = [int](Get-Content -LiteralPath $workdeskPidFile -Raw)
    $workdeskProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $workdeskPid" -ErrorAction SilentlyContinue
    $workdeskExpected = Join-Path $PSScriptRoot 'server.mjs'
    if ($workdeskProcess -and $workdeskProcess.Name -eq 'node.exe' -and $workdeskProcess.CommandLine.Replace('/', '\').Contains($workdeskExpected)) {
        Stop-Process -Id $workdeskPid
        Write-Host '本地工作台已停止，数据保留在 data 文件夹。'
    }
}
