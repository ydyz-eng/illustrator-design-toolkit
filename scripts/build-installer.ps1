# Windows PowerShell 5.1. Save as UTF-8 with BOM.
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'install.ps1')
Assert-ToolboxPackage $projectRoot
[xml] $manifest = [IO.File]::ReadAllText((Join-Path $projectRoot 'CSXS\manifest.xml'))
$version = $manifest.ExtensionManifest.ExtensionBundleVersion
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw '扩展版本格式不正确。' }

$dist = Join-Path $projectRoot 'dist'
$staging = Join-Path $dist ('build-' + [guid]::NewGuid().ToString('N'))
$payload = Join-Path $staging 'AI设计工具箱'
$zip = Join-Path $dist ("AI设计工具箱-$version-Windows-Installer2.zip")
$legacyZip = Join-Path $dist ("AI设计工具箱-$version-Windows.zip")
$tempZip = Join-Path $dist ([guid]::NewGuid().ToString('N') + '.zip')
try {
    Assert-DirectoryChain $dist
    New-Item -ItemType Directory -Path $payload -Force | Out-Null
    foreach ($name in @('CSXS', 'css', 'js', 'jsx', 'index.html', 'docs', '安装说明.md', 'install.bat')) {
        Copy-Item -LiteralPath (Join-Path $projectRoot $name) -Destination $payload -Recurse -Force
    }
    $scripts = Join-Path $payload 'scripts'
    New-Item -ItemType Directory -Path $scripts -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install.ps1') -Destination $scripts
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($staging, $tempZip, [IO.Compression.CompressionLevel]::Optimal, $false)
    $archive = [IO.Compression.ZipFile]::OpenRead($tempZip)
    try {
        $names = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
        foreach ($required in @('install.bat', 'scripts/install.ps1') + (Get-ToolboxRequiredFiles)) {
            if ($names -notcontains ('AI设计工具箱/' + $required.Replace('\', '/'))) {
                throw "安装 ZIP 缺少文件：$required"
            }
        }
    } finally { $archive.Dispose() }
    [IO.File]::Copy($tempZip, $zip, $true)
    # Refresh the original download path too, so it never serves the old installer.
    [IO.File]::Copy($tempZip, $legacyZip, $true)
    Write-Host "已生成安装包：$zip"
    Write-Host ("SHA256：" + (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash)
} finally {
    Assert-PathWithin $staging $dist
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
    Assert-PathWithin $tempZip $dist
    if (Test-Path -LiteralPath $tempZip) { Remove-Item -LiteralPath $tempZip -Force }
}
