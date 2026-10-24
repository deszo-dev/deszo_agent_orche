[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$installRoot=Join-Path $env:ProgramFiles 'Deszo Control Host'
$config=Get-Content -LiteralPath (Join-Path $installRoot 'installation.json') -Raw|ConvertFrom-Json
if($config.serviceName -ne 'DeszoControlHost' -or $config.taskPath -ne '\DeszoControlHost\'){throw 'Unexpected installation identity.'}
$service=Get-CimInstance Win32_Service -Filter "Name='DeszoControlHost'"
$expected='"'+(Join-Path $installRoot 'deszo-control.exe')+'" service'
if($service -and $service.PathName -ne $expected){throw 'Service points to another installation; refusing to change it.'}
foreach($name in @('InteractiveLauncher','ConsentBroker')){
  $task=Get-ScheduledTask -TaskPath $config.taskPath -TaskName $name -ErrorAction SilentlyContinue
  if($task){if($task.Actions[0].Execute -ne (Join-Path $installRoot 'deszo-control.exe')){throw 'Task points to another executable.'};Stop-ScheduledTask -InputObject $task -ErrorAction SilentlyContinue;Unregister-ScheduledTask -InputObject $task -Confirm:$false}
}
if($service){Stop-Service -Name $config.serviceName -ErrorAction SilentlyContinue;& sc.exe delete $config.serviceName;if($LASTEXITCODE -ne 0){throw 'SCM deletion failed.'}}
Write-Output 'Service/task registrations removed. Authority history, application data and installed files are retained.'
