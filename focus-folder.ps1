$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Find-WorkdeskFolderWindow($Windows, [string]$Folder) {
    $target = [System.IO.Path]::GetFullPath($Folder).TrimEnd('\', '/')
    foreach ($window in $Windows) {
        try {
            if ([System.IO.Path]::GetFileName($window.FullName) -ine 'explorer.exe') { continue }
            $actual = [System.IO.Path]::GetFullPath($window.Document.Folder.Self.Path).TrimEnd('\', '/')
            if ([string]::Equals($actual, $target, [StringComparison]::OrdinalIgnoreCase)) {
                return [IntPtr]([long]$window.HWND)
            }
        } catch { } # A window can close or navigate while it is being inspected.
    }
    return [IntPtr]::Zero
}

$foreground = $false
try {
    $folder = $env:WORKDESK_FOCUS_FOLDER
    if ([string]::IsNullOrWhiteSpace($folder)) { throw 'Missing folder' }
    Add-Type -Path (Join-Path $PSScriptRoot 'folder-window.cs')
    $shell = New-Object -ComObject Shell.Application
    $deadline = [DateTime]::UtcNow.AddSeconds(4)
    do {
        $handle = Find-WorkdeskFolderWindow ($shell.Windows()) $folder
        if ($handle -ne [IntPtr]::Zero) {
            $foreground = [WorkdeskFolderForeground]::Activate($handle)
            break
        }
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $deadline)
} catch { } # Opening the folder already succeeded; focusing is best effort.
@{ foreground = $foreground } | ConvertTo-Json -Compress
