[CmdletBinding()]
param([switch]$PrepareOnly)
$ErrorActionPreference='Stop'
$workspaceRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$installRoot=Join-Path $env:ProgramFiles 'Deszo Control Host'
$stateParent=Join-Path $env:ProgramData 'Deszo'
$stateRoot=Join-Path $stateParent 'ControlHost'
$serviceName='DeszoControlHost'
$taskPath='\DeszoControlHost\'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$userSid=$identity.User.Value
$userAccount=$identity.Name
$stage=Join-Path $workspaceRoot '.deszo/build/control-host'
if(-not(Test-Path -LiteralPath (Join-Path $stage 'deszo-control.exe'))){throw 'Build the native Control Host first: node scripts/build-control-host.mjs'}
if(-not(Test-Path -LiteralPath (Join-Path $workspaceRoot 'dist-runtime/service-runtime.mjs'))){throw 'Run npm run runtime:bundle first.'}
$nodePath=(& node -p 'process.execPath').Trim()
if($LASTEXITCODE -ne 0){throw 'Node.js could not be located.'}
$manifest=[ordered]@{serviceName=$serviceName;account='NT AUTHORITY\LocalService';installRoot=$installRoot;stateRoot=$stateRoot;taskPath=$taskPath;tasks=@('InteractiveLauncher','ConsentBroker');userSid=$userSid;userAccount=$userAccount;pipeName='deszo-control-host-v1';mode='bootstrap';dataDeletion=$false;rollback='Stop/remove only these service/task registrations; retain installed files and state.'}
New-Item -ItemType Directory -Path $stage -Force|Out-Null
$manifest|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $stage 'installation-plan.json') -Encoding UTF8
if($PrepareOnly){$manifest|ConvertTo-Json -Depth 8;return}
if(-not([Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))){throw 'Run this installer from an elevated process.'}
if(Get-Service -Name $serviceName -ErrorAction SilentlyContinue){throw "Service $serviceName already exists; the installer will not replace it."}
if(Test-Path -LiteralPath $installRoot){throw "Install directory already exists: $installRoot. Existing contents will not be changed."}
if(Test-Path -LiteralPath $stateRoot){throw "State directory already exists: $stateRoot. Existing authority will not be changed."}
if(Get-ScheduledTask -TaskPath $taskPath -ErrorAction SilentlyContinue){throw "Task namespace $taskPath already exists."}

function Set-ProtectedDirectory([string]$Path,[string]$ServiceSid,[bool]$Writable,[bool]$DesktopReadable){
  $access=if($Writable){'FA'}else{'FRFX'}
  $sddl="O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;$access;;;$ServiceSid)(A;OICI;RC;;;OW)"
  if($DesktopReadable){$sddl+="(A;OICI;FRFX;;;$userSid)"}
  $acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetSecurityDescriptorSddlForm($sddl)
  Set-Acl -LiteralPath $Path -AclObject $acl
}
$serviceCreated=$false
try{
  New-Item -ItemType Directory -Path $installRoot|Out-Null
  if(-not(Test-Path -LiteralPath $stateParent)){New-Item -ItemType Directory -Path $stateParent|Out-Null}
  New-Item -ItemType Directory -Path $stateRoot|Out-Null
  $binary='"'+(Join-Path $installRoot 'deszo-control.exe')+'" service'
  $created=Invoke-CimMethod -ClassName Win32_Service -MethodName Create -Arguments @{Name=$serviceName;DisplayName='Deszo Local Control Host';PathName=$binary;ServiceType=[byte]16;ErrorControl=[byte]1;StartMode='Automatic';DesktopInteract=$false;StartName='NT AUTHORITY\LocalService'}
  if($created.ReturnValue -ne 0){throw "SCM creation failed: $($created.ReturnValue)"};$serviceCreated=$true
  & sc.exe sidtype $serviceName unrestricted|Out-Null;if($LASTEXITCODE -ne 0){throw 'Service SID configuration failed.'}
  & sc.exe failure $serviceName 'reset=' 86400 'actions=' 'restart/3000/restart/10000/restart/30000'|Out-Null;if($LASTEXITCODE -ne 0){throw 'SCM recovery configuration failed.'}
  $serviceSid=([Security.Principal.NTAccount]::new('NT SERVICE',$serviceName)).Translate([Security.Principal.SecurityIdentifier]).Value
  Set-ProtectedDirectory $installRoot $serviceSid $false $true
  # The dedicated parent is protected too, so a candidate cannot replace the authority directory via its parent.
  $parentItems=@(Get-ChildItem -LiteralPath $stateParent -Force)
  if($parentItems.Count -eq 1 -and $parentItems[0].FullName -eq $stateRoot){Set-ProtectedDirectory $stateParent $serviceSid $true $false}
  Set-ProtectedDirectory $stateRoot $serviceSid $true $false
  $sources=[ordered]@{'deszo-control.exe'=(Join-Path $stage 'deszo-control.exe');'deszo-control.exe.config'=(Join-Path $stage 'deszo-control.exe.config');'node.exe'=$nodePath;'service-runtime.mjs'=(Join-Path $workspaceRoot 'dist-runtime/service-runtime.mjs');'host-h1.sql'=(Join-Path $workspaceRoot 'dist-runtime/host-h1.sql');'host-h2.sql'=(Join-Path $workspaceRoot 'dist-runtime/host-h2.sql');'host-h3.sql'=(Join-Path $workspaceRoot 'dist-runtime/host-h3.sql')}
  $sources['host-h4.sql']=Join-Path $workspaceRoot 'dist-runtime/host-h4.sql'
  $sources['host-h5.sql']=Join-Path $workspaceRoot 'dist-runtime/host-h5.sql'
  $sources['worker.mjs']=Join-Path $workspaceRoot 'dist-runtime/worker.mjs'
  $files=[ordered]@{}
  foreach($entry in $sources.GetEnumerator()){Copy-Item -LiteralPath $entry.Value -Destination (Join-Path $installRoot $entry.Key);$files[$entry.Key]=(Get-FileHash -LiteralPath (Join-Path $installRoot $entry.Key) -Algorithm SHA256).Hash.ToLowerInvariant()}
  $config=[ordered]@{version=1;installationId=[Guid]::NewGuid().ToString();serviceName=$serviceName;serviceSid=$serviceSid;userSid=$userSid;userAccount=$userAccount;stateRoot=$stateRoot;pipeName='deszo-control-host-v1';taskPath=$taskPath;files=$files}
  $gitPath=(Get-Command git.exe -CommandType Application -ErrorAction Stop|Select-Object -First 1).Source
  if(-not [IO.Path]::GetFullPath($gitPath).StartsWith(([IO.Path]::GetFullPath($env:ProgramFiles)+[IO.Path]::DirectorySeparatorChar),[StringComparison]::OrdinalIgnoreCase)){throw 'The source metadata tool must be in the protected Program Files installation.'}
  $config.tools=[ordered]@{git=[ordered]@{path=$gitPath;sha256=(Get-FileHash -LiteralPath $gitPath -Algorithm SHA256).Hash.ToLowerInvariant()}}
  $config.buildRoot=Join-Path $stateParent 'Builds'
  $config.profileRoot=Join-Path $env:LOCALAPPDATA 'Deszo/AutonomyProfiles'
  foreach($newRoot in @($config.buildRoot,$config.profileRoot)){if(Test-Path -LiteralPath $newRoot){throw "An autonomy root already exists: $newRoot"};New-Item -ItemType Directory -Path $newRoot -Force|Out-Null;Set-ProtectedDirectory $newRoot $serviceSid $true $true}
  $profileAcl=Get-Acl -LiteralPath $config.profileRoot
  $profileAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($userSid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
  Set-Acl -LiteralPath $config.profileRoot -AclObject $profileAcl
  $utf8=[Text.UTF8Encoding]::new($false)
  [IO.File]::WriteAllText((Join-Path $installRoot 'installation.json'),($config|ConvertTo-Json -Depth 8),$utf8)
  foreach($file in Get-ChildItem -LiteralPath $installRoot -File){$acl=Get-Acl -LiteralPath $file.FullName;$acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'));Set-Acl -LiteralPath $file.FullName -AclObject $acl}
  [IO.File]::WriteAllText((Join-Path $stateRoot 'installation-receipt.json'),($manifest|ConvertTo-Json -Depth 8),$utf8)
  $scheduler=New-Object -ComObject 'Schedule.Service';$scheduler.Connect()
  $folder=$scheduler.GetFolder('\').CreateFolder('DeszoControlHost','D:P(A;;FA;;;SY)(A;;FA;;;BA)')
  $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval ([TimeSpan]::FromMinutes(1))
  $settings.Hidden=$true
  foreach($mode in @('launcher','broker')){
    $name=if($mode -eq 'launcher'){'InteractiveLauncher'}else{'ConsentBroker'}
    $level=if($mode -eq 'launcher'){'Limited'}else{'Highest'}
    $principal=New-ScheduledTaskPrincipal -UserId $userSid -LogonType Interactive -RunLevel $level
    $action=New-ScheduledTaskAction -Execute (Join-Path $installRoot 'deszo-control.exe') -Argument $mode -WorkingDirectory $installRoot
    $arguments=@{TaskName=$name;TaskPath=$taskPath;Action=$action;Principal=$principal;Settings=$settings;Description="Protected Deszo $mode; installation $($config.installationId)"}
    if($mode -eq 'launcher'){$arguments.Trigger=New-ScheduledTaskTrigger -AtLogOn -User $userSid}
    Register-ScheduledTask @arguments|Out-Null
    $folder.GetTask($name).SetSecurityDescriptor("D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRFX;;;$userSid)(A;;FRFX;;;$serviceSid)",0)
  }
  # Folder traversal/start rights without write rights to task definitions.
  $folder.SetSecurityDescriptor("D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRFX;;;$userSid)(A;;FRFX;;;$serviceSid)",0)
  Start-Service -Name $serviceName
  Start-ScheduledTask -TaskPath $taskPath -TaskName InteractiveLauncher
  $manifest|ConvertTo-Json -Depth 8
}catch{
  if($serviceCreated){try{Stop-Service -Name $serviceName -ErrorAction SilentlyContinue;& sc.exe delete $serviceName|Out-Null}catch{}}
  # Preserve state and binaries for diagnosis. No pre-existing file, service or task is deleted by recovery.
  throw
}
