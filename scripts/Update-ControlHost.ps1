[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$workspaceRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$installRoot=Join-Path $env:ProgramFiles 'Deszo Control Host'
$configPath=Join-Path $installRoot 'installation.json'
$config=Get-Content -LiteralPath $configPath -Raw|ConvertFrom-Json
if($config.serviceName -ne 'DeszoControlHost' -or $config.taskPath -ne '\DeszoControlHost\'){throw 'Unexpected installation.'}
$existing=Get-CimInstance Win32_Service -Filter "Name='DeszoControlHost'"
if($existing.PathName -ne ('"'+(Join-Path $installRoot 'deszo-control.exe')+'" service')){throw 'The service does not match this installation.'}
if($existing.StartName -ine 'NT AUTHORITY\LocalService'){throw 'The installed authority is not running under LocalService.'}
$broker=Get-ScheduledTask -TaskPath $config.taskPath -TaskName ConsentBroker
if($broker.State -eq 'Running'){throw 'Close the consent broker before updating its trusted binary.'}
$sources=[ordered]@{'deszo-control.exe'=(Join-Path $workspaceRoot '.deszo/build/control-host/deszo-control.exe');'deszo-control.exe.config'=(Join-Path $workspaceRoot '.deszo/build/control-host/deszo-control.exe.config');'service-runtime.mjs'=(Join-Path $workspaceRoot 'dist-runtime/service-runtime.mjs');'worker.mjs'=(Join-Path $workspaceRoot 'dist-runtime/worker.mjs')}
foreach($version in 1..5){$sources["host-h$version.sql"]=Join-Path $workspaceRoot "dist-runtime/host-h$version.sql"}
foreach($entry in $sources.GetEnumerator()){if(-not (Test-Path -LiteralPath $entry.Value -PathType Leaf)){throw "Missing update artifact before stopping authority: $($entry.Key)"}}
$gitPath=(Get-Command git.exe -CommandType Application -ErrorAction Stop|Select-Object -First 1).Source
if(-not [IO.Path]::GetFullPath($gitPath).StartsWith(([IO.Path]::GetFullPath($env:ProgramFiles)+[IO.Path]::DirectorySeparatorChar),[StringComparison]::OrdinalIgnoreCase)){throw 'The source metadata tool must be in the protected Program Files installation.'}
$gitTool=[ordered]@{path=$gitPath;sha256=(Get-FileHash -LiteralPath $gitPath -Algorithm SHA256).Hash.ToLowerInvariant()}
function Get-InstalledHostMigrations {
  $oldValue=[Environment]::GetEnvironmentVariable('DESZO_MAINTENANCE_STORE','Process')
  try{
    [Environment]::SetEnvironmentVariable('DESZO_MAINTENANCE_STORE',(Join-Path $config.stateRoot 'host.sqlite'),'Process')
    $result=@'
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.env.DESZO_MAINTENANCE_STORE,{readOnly:true});
try{process.stdout.write(JSON.stringify(db.prepare('SELECT version,sha256 FROM host_migrations ORDER BY version').all()));}finally{db.close();}
'@ | & (Join-Path $installRoot 'node.exe') --disable-warning=ExperimentalWarning
    if($LASTEXITCODE -ne 0){throw 'Unable to independently read the protected host migration history.'}
    $rows=($result -join "`n")|ConvertFrom-Json
    foreach($row in $rows){Write-Output $row}
  }finally{[Environment]::SetEnvironmentVariable('DESZO_MAINTENANCE_STORE',$oldValue,'Process')}
}
$beforeMigrations=@(Get-InstalledHostMigrations)
foreach($migration in $beforeMigrations){$name="host-h$($migration.version).sql";if(-not $sources.Contains($name) -or (Get-FileHash -LiteralPath $sources[$name] -Algorithm SHA256).Hash.ToLowerInvariant() -ne $migration.sha256){throw "Applied migration $name differs from the update; authority was not stopped."}}
$backup=Join-Path $config.stateRoot ('updates/'+[Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $backup -Force|Out-Null
foreach($file in Get-ChildItem -LiteralPath $installRoot -File){Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $backup $file.Name)}
$oldProcesses=@()
foreach($process in Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -eq (Join-Path $installRoot 'deszo-control.exe')}){
  try{$held=[Diagnostics.Process]::GetProcessById($process.ProcessId);$null=$held.Handle;$oldProcesses+=$held}catch{}
}
Stop-ScheduledTask -TaskPath $config.taskPath -TaskName InteractiveLauncher
Stop-Service -Name $config.serviceName
foreach($process in $oldProcesses){try{if(-not $process.WaitForExit(10000)){throw 'The previous trusted process has not exited; replacement is refused.'}}finally{$process.Dispose()}}
try{
  $config|Add-Member -MemberType NoteProperty -Name tools -Value ([pscustomobject]@{git=[pscustomobject]$gitTool}) -Force
  foreach($setting in @('buildRoot','profileRoot')){
    if(-not $config.PSObject.Properties[$setting]){
      $newRoot=if($setting -eq 'buildRoot'){Join-Path (Split-Path -Parent $config.stateRoot) 'Builds'}else{Join-Path $env:LOCALAPPDATA 'Deszo/AutonomyProfiles'}
      if(Test-Path -LiteralPath $newRoot){throw "The new autonomy root already exists: $newRoot"}
      New-Item -ItemType Directory -Path $newRoot -Force|Out-Null
      $userAccess=if($setting -eq 'profileRoot'){'FA'}else{'FRFX'}
      $sddl="O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;$($config.serviceSid))(A;OICI;$userAccess;;;$($config.userSid))(A;OICI;RC;;;OW)"
      $acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetSecurityDescriptorSddlForm($sddl);Set-Acl -LiteralPath $newRoot -AclObject $acl
      $config|Add-Member -MemberType NoteProperty -Name $setting -Value $newRoot
    }
  }
  foreach($entry in $sources.GetEnumerator()){Copy-Item -LiteralPath $entry.Value -Destination (Join-Path $installRoot $entry.Key) -Force;$config.files|Add-Member -MemberType NoteProperty -Name $entry.Key -Value (Get-FileHash -LiteralPath (Join-Path $installRoot $entry.Key) -Algorithm SHA256).Hash.ToLowerInvariant() -Force}
  [IO.File]::WriteAllText($configPath,($config|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
  # Recovery restores infrastructure only; queued unknown effects and previous authority remain fail-closed.
  & sc.exe failure $config.serviceName 'reset=' 86400 'actions=' 'restart/3000/restart/10000/restart/30000'|Out-Null
  if($LASTEXITCODE -ne 0){throw 'SCM recovery configuration failed.'}
  foreach($file in Get-ChildItem -LiteralPath $installRoot -File){$acl=Get-Acl -LiteralPath $file.FullName;$acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'));Set-Acl -LiteralPath $file.FullName -AclObject $acl}
  Start-Service -Name $config.serviceName;Start-ScheduledTask -TaskPath $config.taskPath -TaskName InteractiveLauncher
  [pscustomobject]@{updated=$config.installationId;backup=$backup;statePreserved=$true;requiresRuntimeVerification=$true}|ConvertTo-Json
}catch{
  $failure=$_
  try{Stop-ScheduledTask -TaskPath $config.taskPath -TaskName InteractiveLauncher;Stop-Service -Name $config.serviceName -ErrorAction SilentlyContinue}catch{}
  try{$afterMigrations=@(Get-InstalledHostMigrations)}catch{throw "Update failed and migration state cannot be established. New files and protected state retained; no blind downgrade. Backup: $backup. Original error: $failure"}
  if($afterMigrations.Count -gt $beforeMigrations.Count){throw "Update failed after an append-only host migration. New files/state retained; restoring older binaries would not be a compatible rollback. Backup: $backup. Original error: $failure"}
  foreach($file in Get-ChildItem -LiteralPath $backup -File){Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $installRoot $file.Name) -Force}
  try{Start-Service -Name $config.serviceName;Start-ScheduledTask -TaskPath $config.taskPath -TaskName InteractiveLauncher}catch{}
  throw $failure
}
