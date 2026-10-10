$ErrorActionPreference = 'Stop'
try {
    $file = $env:WORKDESK_OPEN_FILE
    if ([string]::IsNullOrWhiteSpace($file)) { throw 'Missing file' }
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $file
    $start.UseShellExecute = $true
    $start.Verb = 'open'
    $start.WorkingDirectory = [System.IO.Path]::GetDirectoryName($file)
    [System.Diagnostics.Process]::Start($start) | Out-Null
    exit 0
} catch {
    exit 1
}
