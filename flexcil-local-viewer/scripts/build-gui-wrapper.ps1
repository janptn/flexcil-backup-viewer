$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Path $PSScriptRoot -Parent
$sourcePath = Join-Path $projectRoot 'launcher\gui-wrapper\Program.cs'
$iconPath = Join-Path $projectRoot 'launcher\logo.ico'
$releaseDir = Join-Path $projectRoot 'release'
$outputPath = Join-Path $releaseDir 'Flexcil-Local-Viewer.exe'

if (-not (Test-Path $sourcePath)) {
  throw "Source file not found: $sourcePath"
}

if (-not (Test-Path $releaseDir)) {
  New-Item -Path $releaseDir -ItemType Directory | Out-Null
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName Microsoft.CSharp

$provider = New-Object Microsoft.CSharp.CSharpCodeProvider
$parameters = New-Object System.CodeDom.Compiler.CompilerParameters
$parameters.GenerateExecutable = $true
$parameters.GenerateInMemory = $false
$parameters.OutputAssembly = $outputPath
$parameters.CompilerOptions = '/target:winexe /optimize+'

if (Test-Path $iconPath) {
  $parameters.CompilerOptions += " /win32icon:`"$iconPath`""
}

$null = $parameters.ReferencedAssemblies.Add('System.dll')
$null = $parameters.ReferencedAssemblies.Add('System.Core.dll')
$null = $parameters.ReferencedAssemblies.Add('System.Drawing.dll')
$null = $parameters.ReferencedAssemblies.Add('System.Windows.Forms.dll')

$results = $provider.CompileAssemblyFromFile($parameters, $sourcePath)

if ($results.Errors.HasErrors) {
  $messages = @()
  foreach ($error in $results.Errors) {
    $messages += $error.ToString()
  }
  throw ("GUI wrapper compilation failed:`n" + ($messages -join "`n"))
}

Write-Host "GUI wrapper built: $outputPath"