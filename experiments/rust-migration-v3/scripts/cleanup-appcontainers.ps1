$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$reportPath = Join-Path $root 'evidence\run.json'
if (-not (Test-Path -LiteralPath $reportPath)) { throw "No run report at $reportPath" }
$report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
$runToken = ([string]$report.run_id).Replace('-', '')
$coreName = "d3v3$($runToken.Substring(0, 12))core"
$coreHangName = "d3v3$($runToken.Substring(0, 8))corehang"
$workerPattern = '^d3v3' + [regex]::Escape($runToken.Substring(0, 8)) + 'w[0-9a-f]{8}$'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DeszoV3AppContainerCleanup {
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    public static extern int DeleteAppContainerProfile(string name);
}
'@

foreach ($name in $report.appcontainer_profiles_created) {
    if ([string]$name -ne $coreName -and [string]$name -ne $coreHangName -and [string]$name -notmatch $workerPattern) {
        throw "Refusing profile name outside this run's exact PoC naming scheme: $name"
    }
    $result = [DeszoV3AppContainerCleanup]::DeleteAppContainerProfile([string]$name)
    if ($result -lt 0 -and $result -ne -2147024894) { throw ('DeleteAppContainerProfile({0}) HRESULT=0x{1:X8}' -f $name, ([uint32]$result)) }
    Write-Output "Deleted or already absent: $name"
}
