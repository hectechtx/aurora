# Stops the AURORA server if it's currently listening on the given port.
param([int]$Port = 4700)

$conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $conns) {
    Write-Output "Nothing listening on port $Port — AURORA doesn't appear to be running there."
    exit
}

$targetPids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($targetPid in $targetPids) {
    try {
        $proc = Get-Process -Id $targetPid -ErrorAction Stop
        Write-Output "Stopping PID $targetPid ($($proc.ProcessName))..."
        Stop-Process -Id $targetPid -Force
    } catch {
        Write-Output "Could not stop PID ${targetPid}: $_"
    }
}
Write-Output "Done."
