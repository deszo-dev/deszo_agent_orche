[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repo = (Resolve-Path (Join-Path $root '..\..')).Path
$release = Join-Path $root 'target\release'
$evidence = Join-Path $root 'evidence'
$runner = Join-Path $PSScriptRoot 'run-poc.ps1'
$names = @('poc-host.exe', 'poc-core.exe', 'poc-worker-a.exe', 'poc-worker-b.exe', 'poc-worker-fault.exe')
$attempt = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ')
$recordPath = Join-Path $evidence 'cross-user-launch.json'
$stdoutTemp = Join-Path $env:TEMP "deszo-v3-$attempt.stdout.tmp"
$stderrTemp = Join-Path $env:TEMP "deszo-v3-$attempt.stderr.tmp"
$stdoutEvidence = Join-Path $evidence "cross-user-$attempt.stdout.txt"
$stderrEvidence = Join-Path $evidence "cross-user-$attempt.stderr.txt"
$locks = New-Object System.Collections.Generic.List[System.IO.FileStream]
$credential = $null
$child = $null
$exitCode = 126
$record = [ordered]@{
    schema = 'deszo-v3-cross-user-launch/1'
    attempt_id = $attempt
    method = 'Windows PowerShell Microsoft.PowerShell.Security secure prompt + Start-Process -Credential'
    source_account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    source_process_id = $PID
    target_account = "$env:COMPUTERNAME\deszo_poc"
    runner = $runner
    runner_arguments = @('-SkipBuild')
    stage = 'validating_selected_build'
    selected_binary_hashes = @()
    binary_lock = 'FileShare.Read; write/delete sharing denied through child exit'
    child_process_id = $null
    child_exit_code = $null
    error = $null
}

function Write-LaunchRecord {
    [IO.File]::WriteAllText($recordPath, ($record | ConvertTo-Json -Depth 7))
}

function Get-SelectedBinaries {
    $records = foreach ($name in $names) {
        $path = Join-Path $release $name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required release executable is missing: $path" }
        $stream = $null
        try {
            $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
            $sha = [Security.Cryptography.SHA256]::Create()
            try { $hash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
            finally { $sha.Dispose() }
            [ordered]@{ name = $name; length = $stream.Length; sha256 = $hash }
        } finally {
            if ($stream) { $stream.Dispose() }
        }
    }
    return @($records)
}

try {
    if ([Security.Principal.WindowsIdentity]::GetCurrent().Name.Split('\')[-1] -ine 'jusse') {
        throw 'Run this launcher from the jusse development account.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $evidence 'build-exit.txt') -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $evidence 'binary-hashes.json') -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $evidence 'experiment-source-sha256.txt') -PathType Leaf)) {
        throw 'Build evidence is incomplete. First run scripts\run-poc.ps1 as jusse to build and capture the selected binaries.'
    }
    $buildRecordPath = Join-Path $evidence 'build-record.json'
    if (Test-Path -LiteralPath $buildRecordPath) {
        $buildRecord = Get-Content -LiteralPath $buildRecordPath -Raw | ConvertFrom-Json
        if ([int]$buildRecord.build_exit_code -ne 0) { throw 'The selected Cargo build did not complete successfully.' }
    } else {
        $buildExit = Get-Content -LiteralPath (Join-Path $evidence 'build-exit.txt') | Select-Object -First 1
        if ($buildExit -notmatch '^\s*0\s*$') { throw "The selected Cargo build exit code is not zero: $buildExit" }
    }

    $expectedJson = Get-Content -LiteralPath (Join-Path $evidence 'binary-hashes.json') -Raw
    $expected = ConvertFrom-Json -InputObject $expectedJson
    if ($expected -isnot [array]) { $expected = @($expected) }
    $selected = @(Get-SelectedBinaries)
    $expectedMap = @{}
    foreach ($entry in $expected) { $expectedMap[$entry.name] = $entry.sha256 }
    foreach ($entry in $selected) {
        if (-not $expectedMap.ContainsKey($entry.name) -or $expectedMap[$entry.name] -ne $entry.sha256) {
            throw "Selected executable hash does not match current build evidence: $($entry.name)"
        }
    }
    $record.selected_binary_hashes = $selected

    foreach ($entry in $selected) {
        $locks.Add([IO.File]::Open((Join-Path $release $entry.name), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read))
    }
    $lockedSelected = @(Get-SelectedBinaries)
    for ($i = 0; $i -lt $selected.Count; $i++) {
        if ($selected[$i].sha256 -ne $lockedSelected[$i].sha256) { throw "Binary changed during lock acquisition: $($selected[$i].name)" }
    }
    $record.stage = 'awaiting_native_windows_credentials'
    Write-LaunchRecord

    $securityModule = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
    Import-Module -Name $securityModule -ErrorAction Stop
    # Get-Credential presents a secure Windows credential prompt. The password is never read, logged or persisted by this script.
    $credential = Get-Credential -UserName $record.target_account -Message 'Authenticate as deszo_poc to run the isolated Variant 3 PoC. Enter the password only in this Windows prompt.'
    if ($null -eq $credential) {
        $record.stage = 'authentication_cancelled'
        $record.error = 'The secure credential prompt was cancelled.'
        $exitCode = 125
    } elseif ($credential.UserName.Split('\')[-1] -ine 'deszo_poc') {
        $record.stage = 'authentication_rejected_before_launch'
        $record.error = 'The entered account name did not match deszo_poc; no child process was started.'
        $exitCode = 4
    } else {
        $record.stage = 'launching_runner_as_target_account'
        Write-LaunchRecord
        $powershell = Join-Path $PSHOME 'powershell.exe'
        $argumentList = @('-NoLogo', '-NoProfile', '-File', $runner, '-SkipBuild')
        $child = Start-Process -FilePath $powershell -Credential $credential -LoadUserProfile -WorkingDirectory $repo `
            -ArgumentList $argumentList -RedirectStandardOutput $stdoutTemp -RedirectStandardError $stderrTemp -PassThru
        $record.child_process_id = $child.Id
        if ($credential.Password) { $credential.Password.Dispose() }
        $credential = $null
        $record.stage = 'runner_started_waiting_for_completion'
        Write-LaunchRecord
        $child.WaitForExit()
        $exitCode = [int]$child.ExitCode
        $record.child_exit_code = $exitCode
        $record.stage = 'runner_completed'
    }
} catch {
    $record.stage = 'launch_failed'
    $record.error = $_.Exception.Message
    if ($child -and -not $child.HasExited) {
        try { $child.WaitForExit() } catch {}
    }
    if ($child -and $child.HasExited) {
        $exitCode = [int]$child.ExitCode
        $record.child_exit_code = $exitCode
    }
} finally {
    if ($credential -and $credential.Password) { $credential.Password.Dispose() }
    foreach ($lock in $locks) { if ($lock) { $lock.Dispose() } }
    foreach ($entry in @(@($stdoutTemp, $stdoutEvidence), @($stderrTemp, $stderrEvidence))) {
        if (Test-Path -LiteralPath $entry[0] -PathType Leaf) {
            Copy-Item -LiteralPath $entry[0] -Destination $entry[1] -Force
            Remove-Item -LiteralPath $entry[0] -Force
        }
    }
    $record.final_binary_hashes = @(Get-SelectedBinaries)
    $record.binary_hashes_unchanged = $true
    for ($i = 0; $i -lt $record.selected_binary_hashes.Count; $i++) {
        if ($record.selected_binary_hashes[$i].sha256 -ne $record.final_binary_hashes[$i].sha256) { $record.binary_hashes_unchanged = $false }
    }
    if (-not $record.binary_hashes_unchanged -and $exitCode -eq 0) { $exitCode = 12; $record.child_exit_code = 12 }
    $record.exit_code = $exitCode
    Write-LaunchRecord
}

Write-Output "Cross-user runner stage: $($record.stage)"
Write-Output "Cross-user exit code: $exitCode"
Write-Output "Evidence: $recordPath"
if ($exitCode -ne 0) { exit $exitCode }
