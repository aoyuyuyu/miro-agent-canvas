param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
$sourceRoot=Split-Path $PSScriptRoot -Parent
$targetRoot=[IO.Path]::GetFullPath($OutputDirectory)
if(Test-Path -LiteralPath $targetRoot){
    Remove-Item -LiteralPath $targetRoot -Recurse -Force
}
Push-Location $sourceRoot
try {
  & npm.cmd run build
  if($LASTEXITCODE -ne 0){throw "Build failed"}
  New-Item -ItemType Directory -Path $targetRoot -Force | Out-Null
  Copy-Item -Path "$sourceRoot/node_modules/electron/dist/*" -Destination $targetRoot -Recurse -Force
  if(Test-Path (Join-Path $targetRoot 'electron.exe')){
      Rename-Item -LiteralPath (Join-Path $targetRoot 'electron.exe') -NewName 'Miro.exe'
  }
  $appRoot=Join-Path $targetRoot 'resources/app'
  New-Item -ItemType Directory -Path $appRoot -Force | Out-Null
  Copy-Item -LiteralPath "$sourceRoot/electron","$sourceRoot/dist" -Destination $appRoot -Recurse -Force
  New-Item -ItemType Directory -Path (Join-Path $appRoot 'node_modules') -Force | Out-Null
  Copy-Item -LiteralPath "$sourceRoot/node_modules/zod" -Destination (Join-Path $appRoot 'node_modules') -Recurse -Force
  Copy-Item -LiteralPath "$sourceRoot/src" -Destination $appRoot -Recurse -Force
  $version=(Get-Content (Join-Path $sourceRoot 'package.json') -Raw | ConvertFrom-Json).version
  @{name='miro';version=$version;main='electron/main.cjs';description='Miro'} | ConvertTo-Json | Set-Content (Join-Path $appRoot 'package.json') -Encoding utf8
  [IO.File]::WriteAllText((Join-Path $targetRoot '打开Miro.cmd'), "@echo off`r`nstart `"`" `"%~dp0Miro.exe`"`r`n", [Text.Encoding]::ASCII)
  Write-Output "可运行版本：$targetRoot/Miro.exe"
} finally { Pop-Location }
