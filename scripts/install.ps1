# Windows PowerShell 5.1. Save this file as UTF-8 with BOM.
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Get-ToolboxRequiredFiles {
    @('CSXS\manifest.xml', 'index.html', 'css\style.css', 'js\CSInterface.js',
      'js\main.js', 'js\dimension.js', 'js\dimension-poll.js', 'js\app.js',
      'jsx\tools.jsx', 'jsx\dimension-pick.jsx')
}

function Get-ToolboxReparseTag([string] $LiteralPath) {
    # OneDrive placeholders are reparse points too. Query the tag instead of
    # treating the ReparsePoint attribute (or an empty LinkType) as a symlink.
    # https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-point-tags
    if (!('AiToolboxInstaller.NativeFileInfo' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace AiToolboxInstaller {
    public static class NativeFileInfo {
        [StructLayout(LayoutKind.Sequential)]
        private struct AttributeTagInfo {
            public uint FileAttributes;
            public uint ReparseTag;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(string name, uint access, uint share,
            IntPtr security, uint disposition, uint flags, IntPtr template);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle,
            int infoClass, out AttributeTagInfo info, uint size);

        public static uint GetReparseTag(string path) {
            // Metadata only; OPEN_EXISTING, OPEN_REPARSE_POINT, BACKUP_SEMANTICS.
            // Opening the reparse point itself avoids following a junction/symlink.
            using (SafeFileHandle handle = CreateFileW(path, 0, 7, IntPtr.Zero,
                3, 0x02200000, IntPtr.Zero)) {
                if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
                AttributeTagInfo info;
                // FILE_INFO_BY_HANDLE_CLASS.FileAttributeTagInfo = 9.
                if (!GetFileInformationByHandleEx(handle, 9, out info, 8))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                return (info.FileAttributes & 0x400) != 0 ? info.ReparseTag : 0;
            }
        }
    }
}
'@
    }
    [AiToolboxInstaller.NativeFileInfo]::GetReparseTag([IO.Path]::GetFullPath($LiteralPath))
}

function Assert-ToolboxFileEntry($Entry) {
    if (!($Entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return }
    try { [uint32] $tag = Get-ToolboxReparseTag $Entry.FullName }
    catch { throw "无法读取文件或目录类型：$($Entry.FullName)。$($_.Exception.Message)" }
    # CLOUD and CLOUD_1..F are provider-managed files, not path redirections.
    $cloudMask = [Convert]::ToUInt32('FFFF0FFF', 16)
    $cloudTag = [Convert]::ToUInt32('9000001A', 16)
    if ($tag -eq 0 -or ($tag -band $cloudMask) -eq $cloudTag) { return }
    throw ("路径包含链接或不支持的重解析类型（0x{0:X8}），请使用普通文件夹：{1}" -f $tag, $Entry.FullName)
}

function Get-ToolboxRuntimeEntries([string] $Root, [string] $Name) {
    $pending = New-Object 'Collections.Generic.Stack[string]'
    $pending.Push((Join-Path $Root $Name))
    while ($pending.Count -gt 0) {
        $entry = Get-Item -LiteralPath $pending.Pop() -Force
        Assert-ToolboxFileEntry $entry
        $entry
        if ($entry.PSIsContainer) {
            foreach ($child in (Get-ChildItem -LiteralPath $entry.FullName -Force)) { $pending.Push($child.FullName) }
        }
    }
}

function Assert-ToolboxPackage([string] $Root) {
    foreach ($relative in (Get-ToolboxRequiredFiles)) {
        $path = Join-Path $Root $relative
        if (!(Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -eq 0) {
            throw "安装包不完整，缺少或为空：$relative。请完整解压 ZIP，保留全部文件后重试。"
        }
    }
    foreach ($name in @('CSXS', 'css', 'js', 'jsx', 'index.html')) {
        Get-ToolboxRuntimeEntries $Root $name | Out-Null
    }
    Assert-ToolboxIdentity $Root
}

function Assert-ToolboxIdentity([string] $Root) {
    $manifestPath = Join-Path $Root 'CSXS\manifest.xml'
    if (!(Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "目录内未找到本扩展的 manifest.xml，为保留原文件已停止安装：$Root"
    }
    [xml] $manifest = [IO.File]::ReadAllText($manifestPath)
    if ($manifest.ExtensionManifest.ExtensionBundleId -ne 'com.aitools.designtoolbox') {
        throw '安装包的扩展标识不匹配，安装已停止。'
    }
}

function Assert-IllustratorClosed {
    if (@(Get-Process -Name Illustrator -ErrorAction SilentlyContinue).Count -gt 0) {
        throw 'Illustrator 正在运行。请先保存文档并完全退出 Illustrator，再双击 install.bat。'
    }
}

function Assert-PlainDirectory([string] $Path) {
    if (Test-Path -LiteralPath $Path) {
        $item = Get-Item -LiteralPath $Path -Force
        if (!$item.PSIsContainer) { throw "目录不可用，请检查：$Path" }
        Assert-ToolboxFileEntry $item
    }
}

function Assert-DirectoryChain([string] $Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        Assert-PlainDirectory $current
        $parent = [IO.Directory]::GetParent($current)
        if ($null -eq $parent) { break }
        $current = $parent.FullName
    }
}

function Assert-PathWithin([string] $Path, [string] $Root) {
    $boundary = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    if (![IO.Path]::GetFullPath($Path).StartsWith($boundary, [StringComparison]::OrdinalIgnoreCase)) {
        throw "操作路径超出了安装范围：$Path"
    }
}

function Restore-CepDebugMode($Changes) {
    foreach ($change in $Changes) {
        if ($change.HadValue) {
            New-ItemProperty -LiteralPath $change.Path -Name PlayerDebugMode -Value $change.Value -PropertyType $change.Kind -Force | Out-Null
        } else {
            Remove-ItemProperty -LiteralPath $change.Path -Name PlayerDebugMode -ErrorAction SilentlyContinue
        }
        # Keep newly created empty CSXS keys: never delete shared Adobe settings.
    }
}

function Enable-CepDebugMode {
    $versions = @(9, 10, 11, 12)
    if (Test-Path -LiteralPath 'HKCU:\Software\Adobe') {
        $versions += @(Get-ChildItem -LiteralPath 'HKCU:\Software\Adobe' | ForEach-Object {
            if ($_.PSChildName -match '^CSXS\.(\d+)$' -and [int]$Matches[1] -ge 9) { [int]$Matches[1] }
        })
    }
    $changes = @()
    try {
        foreach ($version in ($versions | Sort-Object -Unique)) {
            $path = "HKCU:\Software\Adobe\CSXS.$version"
            if (!(Test-Path -LiteralPath $path)) { New-Item -Path $path -Force | Out-Null }
            $key = Get-Item -LiteralPath $path
            $hadValue = $key.GetValueNames() -contains 'PlayerDebugMode'
            $change = [pscustomobject]@{ Path = $path; HadValue = $hadValue; Value = $null; Kind = 'String' }
            if ($hadValue) {
                $change.Value = $key.GetValue('PlayerDebugMode', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                $change.Kind = $key.GetValueKind('PlayerDebugMode').ToString()
            }
            $changes += $change
            New-ItemProperty -LiteralPath $path -Name PlayerDebugMode -Value '1' -PropertyType String -Force | Out-Null
            $key = Get-Item -LiteralPath $path
            if ($key.GetValue('PlayerDebugMode') -ne '1' -or $key.GetValueKind('PlayerDebugMode') -ne 'String') {
                throw "无法验证扩展加载设置：$path"
            }
        }
    } catch {
        $originalError = $_
        try { Restore-CepDebugMode $changes } catch { Write-Warning "恢复原加载设置失败：$($_.Exception.Message)" }
        throw $originalError
    }
    return $changes
}

function Invoke-ToolboxInstallCore {
    param(
        [Parameter(Mandatory = $true)][string] $SourceRoot,
        [Parameter(Mandatory = $true)][string] $AppDataRoot
    )
    $source = [IO.Path]::GetFullPath($SourceRoot).TrimEnd('\')
    $appData = [IO.Path]::GetFullPath($AppDataRoot).TrimEnd('\')
    $extensions = Join-Path $appData 'Adobe\CEP\extensions'
    $target = Join-Path $extensions 'AI设计工具箱'
    $workRoot = Join-Path $appData 'Adobe\AI-Design-Toolbox-Installer'
    $stage = Join-Path $workRoot ('staging\' + [guid]::NewGuid().ToString('N'))
    $backup = $null
    $oldMoved = $false
    $settingsChanged = $false
    $changes = @()

    Assert-ToolboxPackage $source
    Assert-IllustratorClosed
    foreach ($path in @($source, $target, $stage, (Join-Path $workRoot 'backups'))) { Assert-DirectoryChain $path }
    $sameDirectory = [string]::Equals($source, $target, [StringComparison]::OrdinalIgnoreCase)
    if (!$sameDirectory -and ($source.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase) -or $target.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase))) {
        throw '请将安装包解压到桌面或下载目录，再运行安装；不要放在现有插件目录内部。'
    }
    if (Test-Path -LiteralPath $target) { Assert-ToolboxIdentity $target }
    Write-Host "安装位置：$target"
    try {
        if (!$sameDirectory) {
            # Only runtime assets are installed; development files and ZIPs stay out of CEP.
            New-Item -ItemType Directory -Path $stage -Force | Out-Null
            foreach ($name in @('CSXS', 'css', 'js', 'jsx', 'index.html')) {
                $from = Join-Path $source $name
                $entries = @(Get-ToolboxRuntimeEntries $source $name)
                Copy-Item -LiteralPath $from -Destination $stage -Recurse -Force
                foreach ($file in ($entries | Where-Object { !$_.PSIsContainer })) {
                    $relative = $file.FullName.Substring($source.Length + 1)
                    $copied = Join-Path $stage $relative
                    if ((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $copied -Algorithm SHA256).Hash) {
                        throw "文件复制校验失败：$relative"
                    }
                }
            }
            Assert-ToolboxPackage $stage
            New-Item -ItemType Directory -Path $extensions -Force | Out-Null
        }

        Write-Host '正在配置当前 Windows 用户的 CEP 未签名扩展加载设置…'
        $changes = @(Enable-CepDebugMode)
        $settingsChanged = $true
        if (!$sameDirectory) {
            # Keep backups OUTSIDE CEP/extensions to avoid duplicate extension IDs.
            if (Test-Path -LiteralPath $target) {
                $backupParent = Join-Path $workRoot ('backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
                New-Item -ItemType Directory -Path $backupParent -Force | Out-Null
                $backup = Join-Path $backupParent 'AI设计工具箱'
                Assert-PathWithin $target $extensions
                Assert-PathWithin $backup (Join-Path $workRoot 'backups')
                [IO.Directory]::Move($target, $backup)
                $oldMoved = $true
            }
            Assert-PathWithin $stage (Join-Path $workRoot 'staging')
            Assert-PathWithin $target $extensions
            [IO.Directory]::Move($stage, $target)
        }
    } catch {
        $originalError = $_
        if ($oldMoved) {
            try {
                Assert-PathWithin $backup (Join-Path $workRoot 'backups')
                Assert-PathWithin $target $extensions
                [IO.Directory]::Move($backup, $target)
            }
            catch { Write-Warning "自动恢复失败。旧版完整备份位于：$backup。原因：$($_.Exception.Message)" }
        }
        if ($settingsChanged) {
            try { Restore-CepDebugMode $changes } catch { Write-Warning "恢复原加载设置失败：$($_.Exception.Message)" }
        }
        throw $originalError
    } finally {
        # Delete only our GUID staging directory, after checking its absolute boundary.
        $stagingRoot = [IO.Path]::GetFullPath((Join-Path $workRoot 'staging')) + '\'
        if ([IO.Path]::GetFullPath($stage).StartsWith($stagingRoot, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $stage)) {
            try {
                Assert-DirectoryChain $stage
                Remove-Item -LiteralPath $stage -Recurse -Force
            }
            catch { Write-Warning "临时文件未清理，可稍后删除：$stage" }
        }
    }
    [pscustomobject]@{ Target = $target; Backup = $backup; AlreadyInPlace = $sameDirectory }
}

function Invoke-ToolboxInstall {
    param(
        [Parameter(Mandatory = $true)][string] $SourceRoot,
        [Parameter(Mandatory = $true)][string] $AppDataRoot
    )
    $mutex = New-Object Threading.Mutex($false, 'Local\AI-Design-Toolbox-Installer')
    $ownsLock = $false
    try {
        try { $ownsLock = $mutex.WaitOne(0) }
        catch [Threading.AbandonedMutexException] { $ownsLock = $true }
        if (!$ownsLock) { throw '另一个安装程序正在运行，请等待其完成后再重试。' }
        Invoke-ToolboxInstallCore -SourceRoot $SourceRoot -AppDataRoot $AppDataRoot
    } finally {
        if ($ownsLock) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

# Dot-sourcing exposes functions for isolated tests without installing anything.
if ($MyInvocation.InvocationName -ne '.') {
    $transcribing = $false
    $exitCode = 1
    $log = $null
    try {
        Write-Host ''
        Write-Host 'AI 设计工具箱 — Windows 一键安装（安装器 2：OneDrive 兼容修复）' -ForegroundColor Cyan
        Write-Host '安装到当前用户，无需管理员权限。请先保存并退出 Illustrator。'
        Write-Host ''
        if ([string]::IsNullOrWhiteSpace($env:APPDATA)) { throw '未找到当前用户的 APPDATA 目录。' }
        $sourceRoot = Split-Path -Parent $PSScriptRoot
        if (![string]::IsNullOrWhiteSpace($env:AI_TOOLBOX_SOURCE)) { $sourceRoot = $env:AI_TOOLBOX_SOURCE }
        $logRoot = Join-Path $env:APPDATA 'Adobe\AI-Design-Toolbox-Installer\logs'
        try {
            New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
            $log = Join-Path $logRoot ('install-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $PID + '.log')
            Start-Transcript -LiteralPath $log -Force | Out-Null
            $transcribing = $true
        } catch { Write-Warning '无法写入安装日志，将继续安装并在窗口显示结果。' }
        $result = Invoke-ToolboxInstall -SourceRoot $sourceRoot -AppDataRoot $env:APPDATA
        Write-Host ''
        Write-Host '安装成功！' -ForegroundColor Green
        if ($result.AlreadyInPlace) { Write-Host '插件已位于安装目录，文件保持原位，加载设置已修复。' }
        if ($result.Backup) { Write-Host "旧版备份：$($result.Backup)" }
        Write-Host '现在打开 Illustrator，在「窗口 → 扩展（或扩展(旧版)）→ AI 设计工具箱」打开面板。'
        Write-Host '首次打开后可停靠面板；安装器不会修改 Illustrator 的工作区布局。'
        $exitCode = 0
    } catch {
        Write-Host ''
        Write-Host ("安装未完成：" + $_.Exception.Message) -ForegroundColor Red
        Write-Host '请处理以上提示后重新运行 install.bat。'
    } finally {
        if ($transcribing) {
            Write-Host "安装日志：$log"
            Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
        }
    }
    exit $exitCode
}
