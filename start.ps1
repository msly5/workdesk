$ErrorActionPreference = 'Stop'
$workdeskProcess = $null
try {
    $workdeskPort = if ($env:WORKDESK_PORT) { [int]$env:WORKDESK_PORT } else { 4317 }
    $workdeskUrl = "http://127.0.0.1:$workdeskPort"
    try {
        $workdeskHealth = Invoke-RestMethod "$workdeskUrl/api/health" -TimeoutSec 2
    } catch { $workdeskHealth = $null }
    if ($workdeskHealth -and $workdeskHealth.app -eq 'workdesk-local') {
        if ($env:WORKDESK_NO_BROWSER -ne '1') { Start-Process $workdeskUrl }
        Write-Host "本地工作台已打开：$workdeskUrl"
        exit 0
    }

    $workdeskNode = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $workdeskNode) { throw '需要 Node.js 22 或更新版本。请从 https://nodejs.org 安装 LTS 版本，再重新双击 start.cmd。' }
    $workdeskNodeVersion = & $workdeskNode.Source --version
    if ($LASTEXITCODE -ne 0 -or $workdeskNodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) {
        throw "当前 Node.js 版本为 $workdeskNodeVersion，需要 22 或更新版本。请升级后重新启动。"
    }

    $workdeskMissingDependencies = @('@modelcontextprotocol/sdk', 'zod') | Where-Object {
        -not (Test-Path -LiteralPath (Join-Path $PSScriptRoot "node_modules/$_/package.json"))
    }
    if ($workdeskMissingDependencies) {
        $workdeskNpm = Get-Command npm.cmd -ErrorAction SilentlyContinue
        if (-not $workdeskNpm) { throw '找不到 npm。请重新安装 Node.js LTS 版本（包含 npm）后启动。' }
        $workdeskInstallLog = Join-Path $PSScriptRoot 'install.log'
        Write-Host '首次启动正在安装依赖，需要联网，请稍候……'
        Push-Location -LiteralPath $PSScriptRoot
        try {
            # Windows PowerShell 5.1 turns native stderr into error records.
            # Let npm finish, then use its exit code to report installation failure.
            $ErrorActionPreference = 'Continue'
            & $workdeskNpm.Source ci --no-audit --no-fund *> $workdeskInstallLog
            $workdeskInstallExitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = 'Stop'
            Pop-Location
        }
        if ($workdeskInstallExitCode -ne 0) {
            throw "依赖安装失败，请检查网络或 npm 镜像后重试。详细信息：$workdeskInstallLog"
        }
    }

    $workdeskServer = Join-Path $PSScriptRoot 'server.mjs'
    $workdeskProcess = Start-Process -FilePath $workdeskNode.Source -ArgumentList ('"' + $workdeskServer + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $PSScriptRoot 'server.log') -RedirectStandardError (Join-Path $PSScriptRoot 'server-error.log')
    $workdeskProcess.Id | Set-Content -LiteralPath (Join-Path $PSScriptRoot '.server.pid')
    Write-Host '正在启动本地工作台，请稍候……'
    $workdeskDeadline = [DateTime]::UtcNow.AddSeconds(30)
    while ([DateTime]::UtcNow -lt $workdeskDeadline) {
        Start-Sleep -Milliseconds 200
        try {
            $workdeskHealth = Invoke-RestMethod "$workdeskUrl/api/health" -TimeoutSec 1
            if ($workdeskHealth.app -eq 'workdesk-local') {
                if ($env:WORKDESK_NO_BROWSER -ne '1') { Start-Process $workdeskUrl }
                Write-Host "本地工作台已打开：$workdeskUrl"
                exit 0
            }
        } catch {}
        if ($workdeskProcess.HasExited) { break }
    }
    throw '后台服务启动失败，请查看本目录的 server-error.log（也请检查端口是否被占用）。'
} catch {
    if ($workdeskProcess) {
        if (-not $workdeskProcess.HasExited) { Stop-Process -InputObject $workdeskProcess -ErrorAction SilentlyContinue }
        Remove-Item -LiteralPath (Join-Path $PSScriptRoot '.server.pid') -ErrorAction SilentlyContinue
    }
    Write-Host "启动失败：$($_.Exception.Message)"
    exit 1
}
