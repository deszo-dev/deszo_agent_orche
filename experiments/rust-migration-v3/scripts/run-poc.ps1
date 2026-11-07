[CmdletBinding()]
param(
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repo = (Resolve-Path (Join-Path $root '..\..')).Path
$repoGit = $repo.Replace('\', '/')
$evidence = Join-Path $root 'evidence'
New-Item -ItemType Directory -Force -Path $evidence | Out-Null

function Invoke-LoggedProcess {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string]$ArgumentList,
        [Parameter(Mandatory = $true)][string]$LogPath
    )
    $stdoutPath = Join-Path $evidence '.native.stdout.tmp'
    $stderrPath = Join-Path $evidence '.native.stderr.tmp'
    foreach ($tempPath in @($stdoutPath, $stderrPath)) {
        if (Test-Path -LiteralPath $tempPath -PathType Leaf) { Remove-Item -LiteralPath $tempPath -Force }
    }
    $process = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    $stdout = if (Test-Path -LiteralPath $stdoutPath) { [IO.File]::ReadAllText($stdoutPath) } else { '' }
    $stderr = if (Test-Path -LiteralPath $stderrPath) { [IO.File]::ReadAllText($stderrPath) } else { '' }
    [IO.File]::WriteAllText($LogPath, "Command: `"$FilePath`" $ArgumentList`n[stdout]`n$stdout`n[stderr]`n$stderr")
    if ($stdout) { Write-Host -NoNewline $stdout }
    if ($stderr) { Write-Host -NoNewline $stderr }
    foreach ($tempPath in @($stdoutPath, $stderrPath)) {
        if (Test-Path -LiteralPath $tempPath -PathType Leaf) { Remove-Item -LiteralPath $tempPath -Force }
    }
    return [int]$process.ExitCode
}

function Get-ExperimentBinaryRecords {
    param([Parameter(Mandatory = $true)][string]$ReleaseDirectory)

    $names = @('poc-host.exe', 'poc-core.exe', 'poc-worker-a.exe', 'poc-worker-b.exe', 'poc-worker-fault.exe')
    $records = foreach ($name in $names) {
        $path = Join-Path $ReleaseDirectory $name
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

function Get-ExperimentSourceFiles {
    param([Parameter(Mandatory = $true)][string]$ExperimentRoot)
    $target = Join-Path $ExperimentRoot 'target'
    $evidenceDirectory = Join-Path $ExperimentRoot 'evidence'
    return @(Get-ChildItem -LiteralPath $ExperimentRoot -File -Recurse | Where-Object {
        $_.FullName -notlike ($target.TrimEnd('\') + '\*') -and
        $_.FullName -notlike ($evidenceDirectory.TrimEnd('\') + '\*')
    } | Sort-Object FullName)
}

function Get-SourceManifestText {
    param([Parameter(Mandatory = $true)][string]$ExperimentRoot, [Parameter(Mandatory = $true)][object[]]$Files)
    $prefix = $ExperimentRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $lines = foreach ($file in $Files) {
        $relative = $file.FullName.Substring($prefix.Length)
        $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        "$relative $hash"
    }
    $manifest = $lines -join "`n"
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $digest = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($manifest))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    return [pscustomobject]@{ Text = $manifest; Digest = $digest }
}

function Read-SourceManifest {
    param([Parameter(Mandatory = $true)][string]$Path)
    $map = @{}
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Source manifest is missing: $Path" }
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match '^(?<path>.+) (?<hash>[0-9a-fA-F]{64})$') { $map[$matches.path] = $matches.hash.ToLowerInvariant() }
    }
    return $map
}

function Test-CompiledSourceMatchesPreviousBuild {
    param([Parameter(Mandatory = $true)][hashtable]$PreviousManifest, [Parameter(Mandatory = $true)][object[]]$CurrentFiles, [Parameter(Mandatory = $true)][string]$ExperimentRoot)
    $prefix = $ExperimentRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $current = @{}
    foreach ($file in $CurrentFiles) {
        $relative = $file.FullName.Substring($prefix.Length)
        if ($relative -match '(^|\\)Cargo\.(toml|lock)$' -or $relative -match '\.rs$') {
            $current[$relative] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    $previousCompiled = @{}
    foreach ($key in $PreviousManifest.Keys) {
        if ($key -match '(^|\\)Cargo\.(toml|lock)$' -or $key -match '\.rs$') { $previousCompiled[$key] = $PreviousManifest[$key] }
    }
    $keys = @($current.Keys + $previousCompiled.Keys | Sort-Object -Unique)
    $differences = foreach ($key in $keys) {
        if (-not $current.ContainsKey($key) -or -not $previousCompiled.ContainsKey($key) -or $current[$key] -ne $previousCompiled[$key]) { $key }
    }
    return [pscustomobject]@{ Matches = (@($differences).Count -eq 0); Differences = @($differences); CurrentInputCount = $current.Count; PreviousInputCount = $previousCompiled.Count }
}

# Preserve every prior top-level evidence file before replacing current-attempt artifacts.
$attempts = Join-Path $evidence 'attempts'
New-Item -ItemType Directory -Force -Path $attempts | Out-Null
$attemptId = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ')
$archive = Join-Path $attempts $attemptId
while (Test-Path -LiteralPath $archive) {
    $attemptId = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
    $archive = Join-Path $attempts $attemptId
}
$priorEvidence = @(Get-ChildItem -LiteralPath $evidence -File | Sort-Object Name)
if ($priorEvidence.Count -gt 0) {
    New-Item -ItemType Directory -Path $archive | Out-Null
    foreach ($item in $priorEvidence) { Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $archive $item.Name) }
}
$generatedEvidenceNames = @(
    'environment.json', 'source-snapshot.txt', 'experiment-source-sha256.txt', 'build-command.txt', 'build.log',
    'build-record.json', 'artifact-verification.json', 'artifact-integrity.json', 'result-summary.json', 'result-code.txt',
    'launch-command.txt', 'binary-hashes.json', 'run-output.txt', 'preflight-output.txt', 'launcher-preflight.json',
    'launcher-failure.txt', 'operator-handoff.txt', 'profile-api-calls.jsonl', 'profile-api-cleanup.jsonl',
    'profile-diagnostic.json', 'profile-diagnostic-output.txt', 'profile-diagnostic-exit.txt', 'build-exit.txt',
    'preflight-exit.txt', 'host-exit.txt', '.native.stdout.tmp', '.native.stderr.tmp', 'run.json'
)
foreach ($name in $generatedEvidenceNames) {
    $path = Join-Path $evidence $name
    if (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path -Force }
}
Get-ChildItem -LiteralPath $evidence -File -Filter 'run-*.json' | Remove-Item -Force

$osKey = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$version = [Environment]::OSVersion.Version
$sourceFiles = Get-ExperimentSourceFiles -ExperimentRoot $root
$sourceManifest = Get-SourceManifestText -ExperimentRoot $root -Files $sourceFiles
$sourceHashText = $sourceManifest.Text
$sourceDigest = $sourceManifest.Digest
$head = 'not captured'
$branch = 'not captured'
$statusLines = @()
try {
    $head = (& git -c "safe.directory=$repoGit" -C $repo rev-parse HEAD 2>$null).Trim()
    $branch = (& git -c "safe.directory=$repoGit" -C $repo branch --show-current 2>$null).Trim()
    $statusLines = @(& git -c "safe.directory=$repoGit" -C $repo status --short --untracked-files=all 2>$null)
} catch {
    $statusLines = @('Git metadata unavailable under this account; experiment source SHA-256 manifest recorded independently.')
}
$statusHeader = @(
    "Repository: $repo",
    "HEAD: $head",
    "Branch: $branch",
    "Experiment source SHA-256: $sourceDigest",
    "Worktree paths at capture (includes this experiment; Git details may be unavailable under the runtime account):"
) -join [Environment]::NewLine
$statusBody = (@($statusLines | ForEach-Object { [string]$_ }) -join [Environment]::NewLine)
[IO.File]::WriteAllText((Join-Path $evidence 'source-snapshot.txt'), $statusHeader + [Environment]::NewLine + $statusBody + [Environment]::NewLine)

$buildCommand = 'cargo build --release --workspace --offline --locked'
[IO.File]::WriteAllText((Join-Path $evidence 'build-command.txt'), "$buildCommand`n")
$releaseDirectory = Join-Path $root 'target\release'
$hostExe = Join-Path $releaseDirectory 'poc-host.exe'
$priorBuildEvidence = if ($archive -and (Test-Path -LiteralPath $archive)) { $archive } else { '' }
$priorEnvironment = $null
$priorManifest = @{}
$priorBinaryRecords = @()
$priorBuildExitCode = $null
$priorBuildAttemptId = $null
$compiledInputComparison = $null
$toolchain = $null
$cargoBuildExit = $null
$executionBuildMode = if ($SkipBuild) { 'reuse_prebuilt_release_artifacts' } else { 'offline_locked_cargo_build' }
$executionBuildAttempt = $null

if ($SkipBuild) {
    if (-not $priorBuildEvidence -or -not (Test-Path -LiteralPath (Join-Path $priorBuildEvidence 'environment.json'))) {
        throw '-SkipBuild requires prior successful build evidence in the experiment evidence archive.'
    }
    $priorEnvironment = Get-Content -LiteralPath (Join-Path $priorBuildEvidence 'environment.json') -Raw | ConvertFrom-Json
    $buildRecordPath = Join-Path $priorBuildEvidence 'build-record.json'
    if (Test-Path -LiteralPath $buildRecordPath) {
        $priorBuildRecord = Get-Content -LiteralPath $buildRecordPath -Raw | ConvertFrom-Json
        $priorBuildExitCode = [int]$priorBuildRecord.build_exit_code
        $priorBuildAttemptId = [string]$priorBuildRecord.artifact_origin_attempt
    } else {
        $priorBuildExit = Get-Content -LiteralPath (Join-Path $priorBuildEvidence 'build-exit.txt') -ErrorAction Stop | Select-Object -First 1
        if ($priorBuildExit -match '^\s*(\d+)\s*$') { $priorBuildExitCode = [int]$matches[1] }
        $priorBuildAttemptId = Split-Path -Leaf $priorBuildEvidence
    }
    if ($priorBuildExitCode -ne 0) { throw "-SkipBuild requires a previously successful Cargo build; recorded exit code is '$priorBuildExitCode'." }
    if (-not $priorBuildAttemptId) { $priorBuildAttemptId = Split-Path -Leaf $priorBuildEvidence }
    $executionBuildAttempt = $priorBuildAttemptId
    $priorManifest = Read-SourceManifest -Path (Join-Path $priorBuildEvidence 'experiment-source-sha256.txt')
    $compiledInputComparison = Test-CompiledSourceMatchesPreviousBuild -PreviousManifest $priorManifest -CurrentFiles $sourceFiles -ExperimentRoot $root
    if (-not $compiledInputComparison.Matches) {
        [IO.File]::WriteAllText((Join-Path $evidence 'artifact-verification.json'), ($compiledInputComparison | ConvertTo-Json -Depth 5))
        throw "-SkipBuild refused: Cargo inputs changed since the selected successful build: $($compiledInputComparison.Differences -join ', ')"
    }
    $priorBinaryJson = Get-Content -LiteralPath (Join-Path $priorBuildEvidence 'binary-hashes.json') -Raw
    $priorBinaryRecords = ConvertFrom-Json -InputObject $priorBinaryJson
    if ($priorBinaryRecords -isnot [array]) { $priorBinaryRecords = @($priorBinaryRecords) }
    $toolchain = $priorEnvironment.toolchain
    [IO.File]::WriteAllText((Join-Path $evidence 'build.log'), "Cargo build not invoked because -SkipBuild was selected.`nSelected prior build evidence: $priorBuildEvidence`nRecorded Cargo exit code: $priorBuildExitCode`n")
    [IO.File]::WriteAllText((Join-Path $evidence 'build-exit.txt'), "SKIPPED; selected prior Cargo build exit code $priorBuildExitCode`n")
} else {
    $rustc = (& rustc --version).Trim()
    $cargo = (& cargo --version).Trim()
    $activeToolchain = (& rustup show active-toolchain).Trim()
    $rustcVerbose = & rustc -vV
    $target = ($rustcVerbose | Where-Object { $_ -like 'host:*' } | Select-Object -First 1) -replace '^host:\s*', ''
    $toolchain = [ordered]@{ rustc = $rustc; cargo = $cargo; active_toolchain = $activeToolchain; target = $target }
}

$environment = [ordered]@{
    os = [ordered]@{
        environment_osversion = $version.ToString()
        edition = [string]$osKey.ProductName
        edition_id = [string]$osKey.EditionID
        build = "$($osKey.CurrentBuild).$($osKey.UBR)"
        current_build_number = [string]$osKey.CurrentBuildNumber
        display_version = [string]$osKey.DisplayVersion
        build_lab = [string]$osKey.BuildLabEx
        installation_type = [string]$osKey.InstallationType
        winver_observation = 'Not captured automatically by the non-interactive launcher; compare from the desktop session if needed.'
    }
    toolchain = $toolchain
    machine = [ordered]@{
        processor = [string]$env:PROCESSOR_IDENTIFIER
        architecture = [string]$env:PROCESSOR_ARCHITECTURE
    }
    repository = [ordered]@{
        branch = $branch
        head = $head
        dirty_paths_at_snapshot = @($statusLines | Where-Object { $_ -and $_ -notlike 'Git metadata unavailable*' }).Count
        experiment_source_sha256 = $sourceDigest
    }
    execution = [ordered]@{
        account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        process_id = $PID
        session_id = (Get-Process -Id $PID).SessionId
        build_mode = $executionBuildMode
        build_evidence_attempt = $executionBuildAttempt
    }
}
[IO.File]::WriteAllText((Join-Path $evidence 'environment.json'), ($environment | ConvertTo-Json -Depth 6))
[IO.File]::WriteAllText((Join-Path $evidence 'experiment-source-sha256.txt'), $sourceHashText + "`nAggregate SHA-256: $sourceDigest`n")

[IO.File]::WriteAllText((Join-Path $evidence 'launch-command.txt'), "& `"$hostExe`" --preflight`nThen, only when preflight exits 0: & `"$hostExe`"`n")
Push-Location $root
$hostExit = 0
$resultExit = 0
$artifactLocks = New-Object System.Collections.Generic.List[System.IO.FileStream]
try {
    if (-not $SkipBuild) {
        $env:CARGO_INCREMENTAL = '0'
        $cargoExe = (Get-Command cargo.exe -ErrorAction Stop).Source
        $cargoBuildExit = Invoke-LoggedProcess -FilePath $cargoExe -ArgumentList 'build --release --workspace --offline --locked' -LogPath (Join-Path $evidence 'build.log')
        [IO.File]::WriteAllText((Join-Path $evidence 'build-exit.txt'), "$cargoBuildExit`n")
        if ($cargoBuildExit -ne 0) {
            [IO.File]::WriteAllText((Join-Path $evidence 'build-record.json'), (@{ build_executed = $true; cargo_invoked = $true; build_exit_code = $cargoBuildExit; build_command = $buildCommand } | ConvertTo-Json -Depth 4))
            [IO.File]::WriteAllText((Join-Path $evidence 'launcher-failure.txt'), "Offline Cargo build failed with exit code $cargoBuildExit.`n")
            exit $cargoBuildExit
        }
    }

    $binaryRecords = Get-ExperimentBinaryRecords -ReleaseDirectory $releaseDirectory
    $binaryHashMap = @{}
    foreach ($record in $binaryRecords) { $binaryHashMap[$record.name] = $record.sha256 }
    $priorHashMap = @{}
    foreach ($record in $priorBinaryRecords) { $priorHashMap[$record.name] = $record.sha256 }
    $sourceInputsMatch = if ($SkipBuild) { [bool]$compiledInputComparison.Matches } else { [bool]($cargoBuildExit -eq 0) }
    $artifactHashComparison = [ordered]@{ matches_previous_build = $true; differences = @(); prior_build_attempt = $executionBuildAttempt; compiled_source_inputs_match = $sourceInputsMatch }
    if ($SkipBuild) {
        foreach ($name in @('poc-host.exe','poc-core.exe','poc-worker-a.exe','poc-worker-b.exe','poc-worker-fault.exe')) {
            if (-not $priorHashMap.ContainsKey($name) -or $priorHashMap[$name] -ne $binaryHashMap[$name]) {
                $artifactHashComparison.matches_previous_build = $false
                $artifactHashComparison.differences += $name
            }
        }
        if (-not $artifactHashComparison.matches_previous_build) {
            [IO.File]::WriteAllText((Join-Path $evidence 'artifact-verification.json'), ($artifactHashComparison | ConvertTo-Json -Depth 5))
            throw "-SkipBuild refused: executable hashes differ from the selected successful build: $($artifactHashComparison.differences -join ', ')"
        }
    }
    [IO.File]::WriteAllText((Join-Path $evidence 'binary-hashes.json'), ($binaryRecords | ConvertTo-Json -Depth 4))
    [IO.File]::WriteAllText((Join-Path $evidence 'artifact-verification.json'), ($artifactHashComparison | ConvertTo-Json -Depth 5))
    $selectedBuildExit = if ($SkipBuild) { $priorBuildExitCode } else { $cargoBuildExit }
    $artifactOriginAttempt = if ($SkipBuild) { $priorBuildAttemptId } else { $attemptId }
    $buildRecord = [ordered]@{
        build_executed = (-not $SkipBuild)
        cargo_invoked = (-not $SkipBuild)
        build_command = $buildCommand
        build_exit_code = $selectedBuildExit
        artifact_origin_attempt = $artifactOriginAttempt
        selected_binary_hashes = $binaryRecords
        compiled_source_inputs_match_selected_build = $sourceInputsMatch
    }
    [IO.File]::WriteAllText((Join-Path $evidence 'build-record.json'), ($buildRecord | ConvertTo-Json -Depth 6))

    # Hold read-only file handles through the entire run. This permits process image reads while denying write/delete opens.
    foreach ($record in $binaryRecords) {
        $artifactLocks.Add([IO.File]::Open((Join-Path $releaseDirectory $record.name), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read))
    }
    $lockedBinaryRecords = Get-ExperimentBinaryRecords -ReleaseDirectory $releaseDirectory
    $lockedHashesMatch = $true
    for ($i = 0; $i -lt $binaryRecords.Count; $i++) { if ($binaryRecords[$i].sha256 -ne $lockedBinaryRecords[$i].sha256) { $lockedHashesMatch = $false } }
    if (-not $lockedHashesMatch) { throw 'An executable changed between selection and the read-lock acquisition; no PoC process was started.' }
    [IO.File]::WriteAllText((Join-Path $evidence 'artifact-integrity.json'), (@{ state = 'locked'; lock_mode = 'FileShare.Read; write/delete sharing denied'; hashes_verified_after_lock = $true; binary_hashes = $lockedBinaryRecords; lock_count = $artifactLocks.Count } | ConvertTo-Json -Depth 5))

    if (-not $SkipBuild) {
        [IO.File]::WriteAllText((Join-Path $evidence 'build-exit.txt'), "$cargoBuildExit`n")
    }

    $preflightExit = Invoke-LoggedProcess -FilePath $hostExe -ArgumentList '--preflight' -LogPath (Join-Path $evidence 'preflight-output.txt')
    [IO.File]::WriteAllText((Join-Path $evidence 'preflight-exit.txt'), "$preflightExit`n")
    if ($preflightExit -ne 0) {
        $preflightRecord = Get-Content -LiteralPath (Join-Path $evidence 'launcher-preflight.json') -Raw | ConvertFrom-Json
        $message = @"
BLOCKED before Core/Worker launch and before CreateAppContainerProfile.
Preflight exit code: $preflightExit
Decision: $($preflightRecord.decision)
Observed account: $([Security.Principal.WindowsIdentity]::GetCurrent().Name)
Observed integrity RID: $($preflightRecord.integrity_rid)
No profile creation was attempted by this preflight.

The required runtime account for this experiment is deszo_poc. Diagnose the cross-user logon; do not retry under jusse.
Evidence files:
  experiments\rust-migration-v3\evidence\launcher-preflight.json
  experiments\rust-migration-v3\evidence\environment.json
  experiments\rust-migration-v3\evidence\preflight-output.txt
  experiments\rust-migration-v3\evidence\artifact-integrity.json
Also include launcher-failure.txt and run.json if the PoC progresses past preflight.
"@
        [IO.File]::WriteAllText((Join-Path $evidence 'launcher-failure.txt'), $message)
        [IO.File]::WriteAllText((Join-Path $evidence 'operator-handoff.txt'), $message)
        $hostExit = $preflightExit
    } else {
        $hostExit = Invoke-LoggedProcess -FilePath $hostExe -ArgumentList '' -LogPath (Join-Path $evidence 'run-output.txt')
        [IO.File]::WriteAllText((Join-Path $evidence 'host-exit.txt'), "$hostExit`n")
        if ($hostExit -ne 0) {
            $failure = Join-Path $evidence 'launcher-failure.txt'
            $hostDetail = ''
            if (Test-Path -LiteralPath $failure) { $hostDetail = Get-Content -LiteralPath $failure -Raw }
            [IO.File]::WriteAllText($failure, "poc-host exited with code $hostExit. See launcher-preflight.json and run-output.txt.`n$hostDetail")
            if ($hostDetail -match 'CreateAppContainerProfile.*HRESULT=0x80070057') {
                $diagnosticExit = Invoke-LoggedProcess -FilePath $hostExe -ArgumentList '--profile-diagnostic' -LogPath (Join-Path $evidence 'profile-diagnostic-output.txt')
                [IO.File]::WriteAllText((Join-Path $evidence 'profile-diagnostic-exit.txt'), "$diagnosticExit`n")
            }
        }
    }

    $postRunBinaryRecords = Get-ExperimentBinaryRecords -ReleaseDirectory $releaseDirectory
    $postRunHashMap = @{}
    foreach ($record in $postRunBinaryRecords) { $postRunHashMap[$record.name] = $record.sha256 }
    $changedDuringRun = @()
    foreach ($record in $binaryRecords) {
        if (-not $postRunHashMap.ContainsKey($record.name) -or $postRunHashMap[$record.name] -ne $record.sha256) { $changedDuringRun += $record.name }
    }
    $artifactIntegrity = [ordered]@{
        state = $null
        lock_mode = 'FileShare.Read; write/delete sharing denied'
        hashes_verified_after_lock = $lockedHashesMatch
        hashes_verified_after_run = ($changedDuringRun.Count -eq 0)
        changed_binaries = $changedDuringRun
        before = $binaryRecords
        after = $postRunBinaryRecords
    }
    $artifactIntegrity.state = if ($changedDuringRun.Count -eq 0) { 'verified_unchanged' } else { 'FAILED_CHANGED' }
    [IO.File]::WriteAllText((Join-Path $evidence 'artifact-integrity.json'), ($artifactIntegrity | ConvertTo-Json -Depth 6))

    $resultStatus = 'BLOCKED'
    $failedCases = @()
    $blockedCases = @()
    $unprovenCases = @()
    $finished = $false
    if ($preflightExit -ne 0) {
        $resultExit = $preflightExit
        $resultStatus = 'BLOCKED_LAUNCHER_PREFLIGHT'
    } elseif ($hostExit -ne 0) {
        $resultExit = $hostExit
        $resultStatus = 'HOST_ERROR'
    } elseif (-not (Test-Path -LiteralPath (Join-Path $evidence 'run.json') -PathType Leaf)) {
        $resultExit = 9
        $resultStatus = 'INCOMPLETE_NO_RUN_REPORT'
    } else {
        $runReport = Get-Content -LiteralPath (Join-Path $evidence 'run.json') -Raw | ConvertFrom-Json
        $finished = [bool]$runReport.finished
        $failedCases = @($runReport.evidence | Where-Object { $_.outcome -eq 'FAIL' } | ForEach-Object { $_.case })
        $blockedCases = @($runReport.evidence | Where-Object { $_.outcome -eq 'BLOCKED' } | ForEach-Object { $_.case })
        $unprovenCases = @($runReport.evidence | Where-Object { $_.outcome -eq 'UNPROVEN' } | ForEach-Object { $_.case })
        if ($changedDuringRun.Count -gt 0) { $resultExit = 12; $resultStatus = 'FAILED_EXECUTABLE_INTEGRITY' }
        elseif ($failedCases.Count -gt 0) { $resultExit = 8; $resultStatus = 'FAILED_ASSERTIONS' }
        elseif (-not $finished) { $resultExit = 9; $resultStatus = 'INCOMPLETE_RUN' }
        elseif ($blockedCases.Count -gt 0 -or $unprovenCases.Count -gt 0) { $resultExit = 10; $resultStatus = 'PARTIAL_WITH_BLOCKED_OR_UNPROVEN_CASES' }
        else { $resultExit = 0; $resultStatus = 'COMPLETED_ALL_RECORDED_ASSERTIONS_PASSED' }
    }
    if ($changedDuringRun.Count -gt 0 -and $resultExit -eq 0) { $resultExit = 12; $resultStatus = 'FAILED_EXECUTABLE_INTEGRITY' }
    $resultReportPath = if (Test-Path -LiteralPath (Join-Path $evidence 'run.json')) { 'run.json' } else { $null }
    $resultSummary = [ordered]@{
        status = $resultStatus
        exit_code = $resultExit
        launcher_preflight_exit = $preflightExit
        host_exit = $hostExit
        finished = $finished
        failed_cases = $failedCases
        blocked_cases = $blockedCases
        unproven_cases = $unprovenCases
        executable_hashes_unchanged = ($changedDuringRun.Count -eq 0)
        report_path = $resultReportPath
    }
    [IO.File]::WriteAllText((Join-Path $evidence 'result-summary.json'), ($resultSummary | ConvertTo-Json -Depth 6))
    [IO.File]::WriteAllText((Join-Path $evidence 'result-code.txt'), "$resultExit`n")
} finally {
    foreach ($lock in $artifactLocks) { if ($lock) { $lock.Dispose() } }
    Pop-Location
}

Write-Output "PoC evidence saved under $evidence"
if ($archive -and (Test-Path -LiteralPath $archive)) { Write-Output "Prior evidence preserved under $archive" }
if ($resultExit -ne 0) { exit $resultExit }
