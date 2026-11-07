[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repo = (Resolve-Path (Join-Path $root '..\..')).Path
$release = Join-Path $root 'target\release'
$evidence = Join-Path $root 'evidence'
$runner = Join-Path $PSScriptRoot 'run-poc.ps1'
$runasExe = Join-Path $env:SystemRoot 'System32\runas.exe'
$targetPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$names = @('poc-host.exe', 'poc-core.exe', 'poc-worker-a.exe', 'poc-worker-b.exe', 'poc-worker-fault.exe')
$attempt = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ')
$latestRecordPath = Join-Path $evidence 'cross-user-launch.json'
$attemptRecordPath = Join-Path $evidence "cross-user-launch-$attempt.json"
$locks = New-Object System.Collections.Generic.List[System.IO.FileStream]
$startUtc = [DateTime]::UtcNow
$runasExit = $null
$runnerProcessId = $null
$runnerExit = $null
$record = [ordered]@{
    schema = 'deszo-v3-cross-user-launch/1'
    attempt_id = $attempt
    method = 'runas /user:.\deszo_poc'
    source_account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    source_process_id = $PID
    target_account = "$env:COMPUTERNAME\deszo_poc"
    runner = $runner
    runner_arguments = @('-SkipBuild')
    runas_command = $null
    stage = 'validating_selected_build'
    selected_binary_hashes = @()
    binary_lock = 'FileShare.Read; write/delete sharing denied through runtime completion'
    runas_exit_code = $null
    runner_process_id = $null
    runner_exit_code = $null
    actual_launcher_identity = $null
    error = $null
}

function Write-LaunchRecord {
    $json = $record | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($attemptRecordPath, $json)
    [IO.File]::WriteAllText($latestRecordPath, $json)
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
    if (-not (Test-Path -LiteralPath $runasExe -PathType Leaf)) { throw "Windows runas.exe is missing: $runasExe" }
    if (-not (Test-Path -LiteralPath $targetPowerShell -PathType Leaf)) { throw "Windows PowerShell 5.1 is missing: $targetPowerShell" }
    if (-not (Test-Path -LiteralPath (Join-Path $evidence 'build-record.json') -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $evidence 'binary-hashes.json') -PathType Leaf)) {
        throw 'Build evidence is incomplete. Run the offline build as jusse before starting the cross-user test.'
    }
    $buildRecord = Get-Content -LiteralPath (Join-Path $evidence 'build-record.json') -Raw | ConvertFrom-Json
    if ([int]$buildRecord.build_exit_code -ne 0) { throw 'The selected Cargo build did not complete successfully.' }
    $expectedJson = Get-Content -LiteralPath (Join-Path $evidence 'binary-hashes.json') -Raw
    $expected = ConvertFrom-Json -InputObject $expectedJson
    if ($expected -isnot [array]) { $expected = @($expected) }
    $expectedMap = @{}
    foreach ($entry in $expected) { $expectedMap[$entry.name] = $entry.sha256 }

    $selected = @(Get-SelectedBinaries)
    foreach ($entry in $selected) {
        if (-not $expectedMap.ContainsKey($entry.name) -or $expectedMap[$entry.name] -ne $entry.sha256) {
            throw "Selected executable hash does not match current build evidence: $($entry.name)"
        }
    }
    $record.selected_binary_hashes = $selected
    foreach ($entry in $selected) {
        $locks.Add([IO.File]::Open((Join-Path $release $entry.name), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read))
    }
    $locked = @(Get-SelectedBinaries)
    for ($i = 0; $i -lt $selected.Count; $i++) {
        if ($selected[$i].sha256 -ne $locked[$i].sha256) { throw "Binary changed during lock acquisition: $($selected[$i].name)" }
    }

    if ($runner -match '\s' -or $targetPowerShell -match '\s') { throw 'The runner or PowerShell path contains spaces; this runas command was prepared for the current no-space paths.' }
    $targetCommand = "$targetPowerShell -NoLogo -NoProfile -File $runner -SkipBuild"
    $record.runas_command = "runas.exe /user:'.\deszo_poc' `"$targetCommand`""
    $record.stage = 'awaiting_windows_runas_authentication'
    Write-LaunchRecord
    Write-Host 'Windows runas will request the deszo_poc password in this console. Password input is not echoed or recorded.'
    $runasArguments = "/user:.\deszo_poc `"$targetCommand`""
    $runasProcess = Start-Process -FilePath $runasExe -ArgumentList $runasArguments -NoNewWindow -Wait -PassThru
    $runasExit = [int]$runasProcess.ExitCode
    $record.runas_exit_code = $runasExit
    $record.stage = 'waiting_for_target_runner_evidence'
    Write-LaunchRecord

    $deadline = [DateTime]::UtcNow.AddMinutes(30)
    $evidenceWaitStarted = [DateTime]::UtcNow
    while ([DateTime]::UtcNow -lt $deadline) {
        $environmentPath = Join-Path $evidence 'environment.json'
        if (Test-Path -LiteralPath $environmentPath -PathType Leaf) {
            $environmentFile = Get-Item -LiteralPath $environmentPath
            if ($environmentFile.LastWriteTimeUtc -ge $startUtc) {
                $environment = Get-Content -LiteralPath $environmentPath -Raw | ConvertFrom-Json
                $account = [string]$environment.execution.account
                if ($account.Split('\')[-1] -ieq 'deszo_poc') {
                    $runnerProcessId = [int]$environment.execution.process_id
                    $record.actual_launcher_identity = $account
                    $record.runner_process_id = $runnerProcessId
                    $record.stage = 'target_runner_started'
                    Write-LaunchRecord
                    $active = Get-Process -Id $runnerProcessId -ErrorAction SilentlyContinue
                    $summaryPath = Join-Path $evidence 'result-summary.json'
                    $summaryFresh = (Test-Path -LiteralPath $summaryPath -PathType Leaf) -and (Get-Item -LiteralPath $summaryPath).LastWriteTimeUtc -ge $startUtc
                    if (-not $active -and $summaryFresh) {
                        $runnerExit = [int](Get-Content -LiteralPath (Join-Path $evidence 'result-code.txt') -Raw).Trim()
                        $record.runner_exit_code = $runnerExit
                        $record.stage = 'target_runner_completed'
                        break
                    }
                } elseif ($account) {
                    throw "The target runner started as '$account', not deszo_poc."
                }
            }
        }
        if ($runasExit -ne 0 -and ([DateTime]::UtcNow - $evidenceWaitStarted).TotalSeconds -gt 10 -and $null -eq $runnerProcessId) {
            throw "runas.exe returned exit code $runasExit without a deszo_poc runner identity record."
        }
        Start-Sleep -Milliseconds 500
    }
    if ($record.stage -ne 'target_runner_completed') { throw 'Timed out waiting for completed deszo_poc run evidence.' }
} catch {
    $record.stage = 'launch_failed_or_incomplete'
    $record.error = $_.Exception.Message
} finally {
    foreach ($lock in $locks) { if ($lock) { $lock.Dispose() } }
    $record.final_binary_hashes = @(Get-SelectedBinaries)
    $record.binary_hashes_unchanged = $true
    for ($i = 0; $i -lt $record.selected_binary_hashes.Count; $i++) {
        if ($record.selected_binary_hashes[$i].sha256 -ne $record.final_binary_hashes[$i].sha256) { $record.binary_hashes_unchanged = $false }
    }
    if (-not $record.binary_hashes_unchanged -and $record.runner_exit_code -eq 0) {
        $record.runner_exit_code = 12
        $record.error = 'A selected executable changed during the run despite the read-only file lock.'
    }
    $record.final_exit_code = if ($record.runner_exit_code -ne $null) { $record.runner_exit_code } elseif ($record.runas_exit_code -ne $null) { $record.runas_exit_code } else { 126 }
    Write-LaunchRecord
}

Write-Host "Cross-user launch stage: $($record.stage)"
Write-Host "Runas exit code: $($record.runas_exit_code)"
Write-Host "Target runner exit code: $($record.runner_exit_code)"
Write-Host "Evidence: $attemptRecordPath"
$crossUserSummary = [ordered]@{
    schema = 'deszo-v3-cross-user-result/1'
    attempt_id = $attempt
    status = if ($record.stage -eq 'target_runner_completed') { 'RUNTIME_COMPLETED' } else { 'BLOCKED_CROSS_USER_LAUNCH' }
    launcher_started = ($null -ne $record.runner_process_id)
    actual_launcher_identity = $record.actual_launcher_identity
    runas_exit_code = $record.runas_exit_code
    runner_exit_code = $record.runner_exit_code
    exit_code = $record.final_exit_code
    binary_hashes_unchanged = $record.binary_hashes_unchanged
    error = $record.error
    attempt_record = (Split-Path -Leaf $attemptRecordPath)
}
[IO.File]::WriteAllText((Join-Path $evidence 'cross-user-result-summary.json'), ($crossUserSummary | ConvertTo-Json -Depth 7))
[IO.File]::WriteAllText((Join-Path $evidence 'cross-user-result-code.txt'), "$($record.final_exit_code)`n")
if ($record.final_exit_code -ne 0) { exit ([int]$record.final_exit_code) }
