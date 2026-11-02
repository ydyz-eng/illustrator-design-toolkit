# Windows PowerShell 5.1 integration tests. Save as UTF-8 with BOM.
# All installation files stay in tests/.installer-<guid>; Adobe settings are mocked.
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$testsRoot = Join-Path $projectRoot 'tests'
$testRoot = Join-Path $testsRoot ('.installer-' + [guid]::NewGuid().ToString('N'))
$script:failures = 0
$script:passed = 0
$script:fixtureNumber = 0
$script:junctions = @()

. (Join-Path $PSScriptRoot 'install.ps1')

# Cloud placeholders cannot be created without a registered sync provider. Mock only
# filesystem metadata/tag reads; install, copy, hashing, and rollback remain real.
$script:readActualReparseTag = (Get-Command Get-ToolboxReparseTag).ScriptBlock
function Get-Item {
    param([string] $LiteralPath, [switch] $Force)
    $item = Microsoft.PowerShell.Management\Get-Item @PSBoundParameters
    $key = [IO.Path]::GetFullPath($LiteralPath)
    if ($script:mockReparseTags.ContainsKey($key)) {
        [pscustomobject]@{
            FullName = $item.FullName
            Name = $item.Name
            PSIsContainer = $item.PSIsContainer
            Attributes = $item.Attributes -bor [IO.FileAttributes]::ReparsePoint
            Length = $(if ($item.PSIsContainer) { 0 } else { $item.Length })
        }
    } else { $item }
}

function Get-ToolboxReparseTag([string] $LiteralPath) {
    $key = [IO.Path]::GetFullPath($LiteralPath)
    $script:probedReparsePaths += $key
    if ($script:mockReparseTags.ContainsKey($key)) { return [uint32] $script:mockReparseTags[$key] }
    & $script:readActualReparseTag $LiteralPath
}

function Set-MockedReparseTag([string] $Path, [uint32] $Tag) {
    $script:mockReparseTags[[IO.Path]::GetFullPath($Path)] = $Tag
}

function Assert-FixturePath([string] $Path) {
    $fullPath = [IO.Path]::GetFullPath($Path)
    $boundary = [IO.Path]::GetFullPath($testRoot).TrimEnd('\') + '\'
    Assert-True ($fullPath.StartsWith($boundary, [StringComparison]::OrdinalIgnoreCase)) "Path is outside test fixtures: $Path"
}

# Override these functions before any invocation: never touch HKCU or a real host.
function Assert-IllustratorClosed {
    if ($script:mockIllustratorRunning) { throw 'TEST: Illustrator is running.' }
}

function Enable-CepDebugMode {
    $script:enableCalls++
    if ($script:mockDebugFailure) { throw 'TEST: registry write denied.' }
    if ($script:mockMoveFailure) {
        $stagingRoot = Join-Path $script:mockAppData 'Adobe\AI-Design-Toolbox-Installer\staging'
        $stages = @(Get-ChildItem -LiteralPath $stagingRoot -Directory -Force)
        if ($stages.Count -ne 1) { throw 'TEST: expected exactly one staging directory.' }
        $parkedStage = Join-Path $script:mockAppData 'parked-stage'
        [IO.Directory]::Move($stages[0].FullName, $parkedStage)
    }
    [pscustomobject]@{ Token = 'in-memory-debug-state' }
}

function Restore-CepDebugMode($Changes) {
    $script:restoreCalls++
    if (@($Changes).Count -ne 1 -or $Changes[0].Token -ne 'in-memory-debug-state') {
        throw 'TEST: incorrect debug state supplied for rollback.'
    }
}

function Assert-True([bool] $Condition, [string] $Message) {
    if (!$Condition) { throw $Message }
}

function Write-FixtureFile([string] $Path, [string] $Text) {
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path)) | Out-Null
    [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false)))
}

function New-Package([string] $Root, [string] $Revision = 'new') {
    foreach ($relative in (Get-ToolboxRequiredFiles)) {
        Write-FixtureFile (Join-Path $Root $relative) "$Revision content for $relative"
    }
    $manifest = [IO.File]::ReadAllText((Join-Path $projectRoot 'CSXS\manifest.xml'))
    Write-FixtureFile (Join-Path $Root 'CSXS\manifest.xml') $manifest
    Write-FixtureFile (Join-Path $Root 'js\nested\extra.js') "$Revision nested runtime asset"
    foreach ($relative in @('README.md', 'install.bat', 'package.json', 'scripts\developer.ps1',
                           'node_modules\dev-only.txt', '.git\config', 'backups\old.txt')) {
        Write-FixtureFile (Join-Path $Root $relative) 'This development file must not be installed.'
    }
}

function New-Fixture([switch] $OneDrive, [switch] $PlainPath) {
    $script:fixtureNumber++
    # Most scenarios exercise literal paths including CMD metacharacters. New-Item
    # Junction lacks -LiteralPath in Windows PowerShell, so it needs a plain case.
    $caseName = if ($PlainPath) { "case-$script:fixtureNumber" } else { "case-$script:fixtureNumber 中文 空格 & () [] ! ' %" }
    $root = Join-Path $testRoot $caseName
    $source = Join-Path $root $(if ($OneDrive) { 'OneDrive\桌面\安装包 source' } else { '安装包 source' })
    $appData = Join-Path $root '用户 AppData'
    New-Package $source
    $script:mockAppData = $appData
    [pscustomobject]@{
        Root = $root
        Source = $source
        AppData = $appData
        Target = Join-Path $appData 'Adobe\CEP\extensions\AI设计工具箱'
        WorkRoot = Join-Path $appData 'Adobe\AI-Design-Toolbox-Installer'
    }
}

function Get-TreeSnapshot([string] $Root) {
    if (!(Test-Path -LiteralPath $Root)) { return '<absent>' }
    $entries = @(Get-ChildItem -LiteralPath $Root -Recurse -Force | Sort-Object FullName)
    $lines = @('ROOT')
    foreach ($entry in $entries) {
        $relative = $entry.FullName.Substring($Root.Length + 1)
        if ($entry.PSIsContainer) { $lines += "DIR|$relative" }
        else {
            $hash = (Get-FileHash -LiteralPath $entry.FullName -Algorithm SHA256).Hash
            $lines += "FILE|$relative|$hash|$($entry.LastWriteTimeUtc.Ticks)"
        }
    }
    $lines -join "`n"
}

function Assert-Runtime([string] $Source, [string] $Target) {
    Assert-ToolboxPackage $Target
    $expectedRootNames = @('CSXS', 'css', 'js', 'jsx', 'index.html') | Sort-Object
    $actualRootNames = @(Get-ChildItem -LiteralPath $Target -Force | Select-Object -ExpandProperty Name | Sort-Object)
    Assert-True (($actualRootNames -join '|') -eq ($expectedRootNames -join '|')) 'Installed unexpected root assets.'
    foreach ($name in $expectedRootNames) {
        $from = Join-Path $Source $name
        $entries = @(Get-Item -LiteralPath $from -Force)
        if ($entries[0].PSIsContainer) { $entries += @(Get-ChildItem -LiteralPath $from -Recurse -File -Force) }
        foreach ($file in ($entries | Where-Object { !$_.PSIsContainer })) {
            $relative = $file.FullName.Substring($Source.Length + 1)
            $destination = Join-Path $Target $relative
            Assert-True (Test-Path -LiteralPath $destination -PathType Leaf) "Missing runtime file: $relative"
            Assert-True ((Get-FileHash -LiteralPath $file.FullName).Hash -eq (Get-FileHash -LiteralPath $destination).Hash) "Wrong runtime file content: $relative"
        }
    }
}

function Assert-Fails([scriptblock] $Action, [string] $ExpectedMessage = '') {
    $caught = $null
    try { & $Action | Out-Null } catch { $caught = $_ }
    Assert-True ($null -ne $caught) 'Expected installation to fail.'
    if ($ExpectedMessage) {
        Assert-True ($caught.Exception.Message.Contains($ExpectedMessage)) "Unexpected error: $($caught.Exception.Message)"
    }
}

function Assert-NoStaging([string] $WorkRoot) {
    $stagingRoot = Join-Path $WorkRoot 'staging'
    if (Test-Path -LiteralPath $stagingRoot) {
        Assert-True (@(Get-ChildItem -LiteralPath $stagingRoot -Force).Count -eq 0) 'Staging directory was not cleaned.'
    }
}

function Invoke-TestBat([string] $BatPath) {
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $env:ComSpec
    # Expand the path once through an environment variable, with delayed expansion off.
    $start.Arguments = '/D /V:OFF /S /C ""%AI_TOOLBOX_TEST_BAT%""'
    $start.EnvironmentVariables['AI_TOOLBOX_TEST_BAT'] = $BatPath
    $start.WorkingDirectory = $testRoot
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    try {
        [void] $process.Start()
        $outputTask = $process.StandardOutput.ReadToEndAsync()
        $errorTask = $process.StandardError.ReadToEndAsync()
        $process.StandardInput.WriteLine('')
        $process.StandardInput.Close()
        if (!$process.WaitForExit(20000)) {
            $process.Kill()
            $process.WaitForExit()
            throw 'BAT entrypoint did not complete within 20 seconds.'
        }
        [pscustomobject]@{
            ExitCode = $process.ExitCode
            Output = $outputTask.Result
            ErrorOutput = $errorTask.Result
        }
    } finally { $process.Dispose() }
}

function Run-Test([string] $Name, [scriptblock] $Body) {
    $script:mockIllustratorRunning = $false
    $script:mockDebugFailure = $false
    $script:mockMoveFailure = $false
    $script:mockAppData = ''
    $script:enableCalls = 0
    $script:restoreCalls = 0
    $script:mockReparseTags = @{}
    $script:probedReparsePaths = @()
    try {
        & $Body
        $script:passed++
        Write-Host "PASS $Name" -ForegroundColor Green
    } catch {
        $script:failures++
        Write-Host "FAIL $Name : $($_.Exception.Message)" -ForegroundColor Red
        Write-Host $_.ScriptStackTrace
    }
}

try {
    Run-Test 'native tag probe reports ordinary files and directories as zero' {
        $f = New-Fixture
        foreach ($path in @($f.Source, (Join-Path $f.Source 'index.html'))) {
            $tag = Get-ToolboxReparseTag $path
            Assert-True ($tag -is [uint32] -and $tag -eq 0) "Ordinary path returned a nonzero or non-uint32 tag: $path ($tag)"
        }
    }

    Run-Test 'cloud tag variants are accepted and adjacent unknown tags are rejected' {
        $f = New-Fixture
        $path = Join-Path $f.Source 'index.html'
        $cloudTag = [Convert]::ToUInt32('9000001A', 16)
        for ($variant = 0; $variant -lt 16; $variant++) {
            Set-MockedReparseTag $path ([uint32] ($cloudTag + ($variant * 4096)))
            Assert-ToolboxFileEntry (Get-Item -LiteralPath $path -Force)
        }
        foreach ($tag in @('90000019', '9000001B', '9001001A', '9000011A', 'A0000003', 'A000000C')) {
            Set-MockedReparseTag $path ([Convert]::ToUInt32($tag, 16))
            Assert-Fails { Assert-ToolboxFileEntry (Get-Item -LiteralPath $path -Force) }
        }
        Assert-True ($script:probedReparsePaths.Count -eq 22) 'File entry validation bypassed the tag probe.'
    }

    Run-Test 'OneDrive desktop ancestor allows full installation' {
        $f = New-Fixture -OneDrive
        $desktop = Split-Path -Parent $f.Source
        Set-MockedReparseTag $desktop ([Convert]::ToUInt32('9000001A', 16))
        $before = Get-TreeSnapshot $f.Source
        $result = Invoke-ToolboxInstall -SourceRoot $f.Source -AppDataRoot $f.AppData
        Assert-Runtime $f.Source $f.Target
        Assert-True ($script:probedReparsePaths -contains $desktop) 'OneDrive desktop ancestor was not checked.'
        Assert-True ((Get-TreeSnapshot $f.Source) -eq $before) 'OneDrive source changed.'
        Assert-True ($result.Target -eq $f.Target -and $script:enableCalls -eq 1) 'OneDrive install did not complete.'
        Assert-NoStaging $f.WorkRoot
    }

    Run-Test 'cloud payload files and nested directories allow verified copy' {
        $f = New-Fixture
        $paths = @((Join-Path $f.Source 'CSXS\manifest.xml'), (Join-Path $f.Source 'js'),
                   (Join-Path $f.Source 'js\nested'), (Join-Path $f.Source 'js\nested\extra.js'))
        foreach ($path in $paths) { Set-MockedReparseTag $path ([Convert]::ToUInt32('9000F01A', 16)) }
        $result = Invoke-ToolboxInstall -SourceRoot $f.Source -AppDataRoot $f.AppData
        Assert-Runtime $f.Source $f.Target
        foreach ($path in $paths) {
            Assert-True ($script:probedReparsePaths -contains $path) "Cloud payload entry was not checked: $path"
        }
        Assert-True ($result.Target -eq $f.Target -and $script:enableCalls -eq 1) 'Cloud payload install did not complete.'
        Assert-NoStaging $f.WorkRoot
    }

    Run-Test 'cloud target ancestor allows installation' {
        $f = New-Fixture
        [IO.Directory]::CreateDirectory($f.AppData) | Out-Null
        Set-MockedReparseTag $f.AppData ([Convert]::ToUInt32('9000501A', 16))
        $result = Invoke-ToolboxInstall -SourceRoot $f.Source -AppDataRoot $f.AppData
        Assert-Runtime $f.Source $f.Target
        Assert-True ($script:probedReparsePaths -contains $f.AppData) 'Cloud target ancestor was not checked.'
        Assert-True ($result.Target -eq $f.Target) 'Cloud target ancestor install did not complete.'
        Assert-NoStaging $f.WorkRoot
    }

    Run-Test 'junction, symlink, and unknown metadata still preserve the old install' {
        foreach ($tag in @('A0000003', 'A000000C', '9001001A')) {
            foreach ($location in @('source ancestor', 'payload directory', 'payload file', 'target ancestor')) {
                $f = New-Fixture -OneDrive
                New-Package $f.Target 'old'
                $before = Get-TreeSnapshot $f.Target
                $path = switch ($location) {
                    'source ancestor' { Split-Path -Parent $f.Source }
                    'payload directory' { Join-Path $f.Source 'js\nested' }
                    'payload file' { Join-Path $f.Source 'js\nested\extra.js' }
                    'target ancestor' { $f.AppData }
                }
                Set-MockedReparseTag $path ([Convert]::ToUInt32($tag, 16))
                Assert-Fails { Invoke-ToolboxInstall -SourceRoot $f.Source -AppDataRoot $f.AppData }
                Assert-True ($script:probedReparsePaths -contains $path) "Rejected entry was not probed: $location ($tag)"
                Assert-True ((Get-TreeSnapshot $f.Target) -eq $before) "Rejected $location ($tag) changed old installation."
                Assert-True ($script:enableCalls -eq 0) "Rejected $location ($tag) attempted settings changes."
                Assert-NoStaging $f.WorkRoot
            }
        }
    }

    Run-Test 'native junction tag is detected and runtime traversal rejects it' {
        $f = New-Fixture -PlainPath
        $link = Join-Path $f.Source 'js\linked-fixture'
        $linkTarget = Join-Path $f.Root 'junction-target'
        Assert-FixturePath $link
        Assert-FixturePath $linkTarget
        Write-FixtureFile (Join-Path $linkTarget 'keep.txt') 'Fixture junction target must remain intact.'
        $script:junctions += [pscustomobject]@{ Link = $link; Target = $linkTarget }
        try { New-Item -ItemType Junction -Path $link -Value $linkTarget -ErrorAction Stop | Out-Null }
        catch { throw "Native junction creation unavailable; this scenario was not verified: $($_.Exception.Message)" }
        $tag = Get-ToolboxReparseTag $link
        Assert-True ($tag -is [uint32] -and $tag -eq [Convert]::ToUInt32('A0000003', 16)) "Wrong native junction tag: $tag"
        Assert-Fails { Assert-PlainDirectory $link }
        Assert-Fails { Invoke-ToolboxInstall -SourceRoot $f.Source -AppDataRoot $f.AppData }
        Assert-True (!(Test-Path -LiteralPath $f.Target) -and $script:enableCalls -eq 0) 'Junction allowed installation or settings changes.'
        Assert-True ([IO.File]::ReadAllText((Join-Path $linkTarget 'keep.txt')) -eq 'Fixture junction target must remain intact.') 'Junction target changed.'
    }

    Run-Test 'first install, runtime allowlist, and special-character paths' {
        $f = New-Fixture
        $before = Get-TreeSnapshot $f.Source
        $result = Invoke-ToolboxInstall -SourceRoot $f.Source -AppDataRoot $f.AppData
        Assert-Runtime $f.Source $f.Target
        Assert-True ($result.Target -eq $f.Target -and !$result.AlreadyInPlace -and !$result.Backup) 'Wrong first-install result.'
        Assert-True ((Get-TreeSnapshot $f.Source) -eq $before) 'Source package changed.'
        Assert-True ($script:enableCalls -eq 1 -and $script:restoreCalls -eq 0) 'Wrong debug settings calls.'
        Assert-NoStaging $f.WorkRoot
    }

    Run-Test 'upgrade keeps complete backup outside CEP and replaces runtime' {
        $f = New-Fixture
        New-Package $f.Target 'old'
        Write-FixtureFile (Join-Path $f.Target 'custom\user-preserved.txt') 'User content must survive in backup.'
        $old = Get-TreeSnapshot $f.Target
        $result = Invoke-ToolboxInstall -SourceRoot $f.Source -AppDataRoot $f.AppData
        Assert-Runtime $f.Source $f.Target
        Assert-True (![string]::IsNullOrWhiteSpace($result.Backup)) 'Upgrade did not return backup path.'
        Assert-True ((Get-TreeSnapshot $result.Backup) -eq $old) 'Backup is not a complete copy of the old extension.'
        $cepRoot = [IO.Path]::GetFullPath((Join-Path $f.AppData 'Adobe\CEP')) + '\'
        Assert-True (!$result.Backup.StartsWith($cepRoot, [StringComparison]::OrdinalIgnoreCase)) 'Backup is inside CEP.'
        Assert-NoStaging $f.WorkRoot
    }

    Run-Test 'running from installed directory leaves every file untouched' {
        $f = New-Fixture
        New-Package $f.Target 'installed'
        $before = Get-TreeSnapshot $f.Target
        $result = Invoke-ToolboxInstall -SourceRoot $f.Target -AppDataRoot $f.AppData
        Assert-True ($result.AlreadyInPlace -and !$result.Backup) 'Installed source was not recognized.'
        Assert-True ((Get-TreeSnapshot $f.Target) -eq $before) 'In-place install changed files or timestamps.'
        Assert-True ($script:enableCalls -eq 1) 'In-place install did not configure debug mode.'
    }

    Run-Test 'missing runtime file refuses before changing existing install' {
        $f = New-Fixture
        New-Package $f.Target 'old'
        $before = Get-TreeSnapshot $f.Target
        [IO.File]::Delete((Join-Path $f.Source 'js\main.js'))
        Assert-Fails { Invoke-ToolboxInstall -SourceRoot $f.Source -AppDataRoot $f.AppData }
        Assert-True ((Get-TreeSnapshot $f.Target) -eq $before) 'Invalid package changed old installation.'
        Assert-True ($script:enableCalls -eq 0) 'Invalid package attempted to change debug settings.'
    }

    Run-Test 'incorrect bundle ID refuses before changing existing install' {
        $f = New-Fixture
        New-Package $f.Target 'old'
        $before = Get-TreeSnapshot $f.Target
        $manifestPath = Join-Path $f.Source 'CSXS\manifest.xml'
        $manifest = [IO.File]::ReadAllText($manifestPath).Replace('com.aitools.designtoolbox', 'com.example.other')
        Write-FixtureFile $manifestPath $manifest
        Assert-Fails { Invoke-ToolboxInstall -SourceRoot $f.Source -AppDataRoot $f.AppData }
        Assert-True ((Get-TreeSnapshot $f.Target) -eq $before) 'Wrong extension ID changed old installation.'
        Assert-True ($script:enableCalls -eq 0) 'Wrong extension ID attempted to change debug settings.'
    }

    Run-Test 'running Illustrator refuses before filesystem or settings changes' {
        $f = New-Fixture
        $script:mockIllustratorRunning = $true
        Assert-Fails { Invoke-ToolboxInstall -SourceRoot $f.Source -AppDataRoot $f.AppData } 'TEST: Illustrator is running.'
        Assert-True (!(Test-Path -LiteralPath $f.Target)) 'Running host allowed installation.'
        Assert-True ($script:enableCalls -eq 0) 'Running host attempted to change debug settings.'
    }

    Run-Test 'debug settings failure leaves old installation intact' {
        $f = New-Fixture
        New-Package $f.Target 'old'
        $before = Get-TreeSnapshot $f.Target
        $script:mockDebugFailure = $true
        Assert-Fails { Invoke-ToolboxInstall -SourceRoot $f.Source -AppDataRoot $f.AppData } 'TEST: registry write denied.'
        Assert-True ((Get-TreeSnapshot $f.Target) -eq $before) 'Debug settings failure modified old installation.'
        Assert-True ($script:enableCalls -eq 1 -and $script:restoreCalls -eq 0) 'Unexpected outer settings rollback calls.'
        Assert-NoStaging $f.WorkRoot
    }

    Run-Test 'failed final move rolls back old installation and debug settings' {
        $f = New-Fixture
        New-Package $f.Target 'old'
        $before = Get-TreeSnapshot $f.Target
        $script:mockMoveFailure = $true
        Assert-Fails { Invoke-ToolboxInstall -SourceRoot $f.Source -AppDataRoot $f.AppData }
        Assert-True ((Get-TreeSnapshot $f.Target) -eq $before) 'Failed final move did not restore the old installation.'
        Assert-True ($script:enableCalls -eq 1 -and $script:restoreCalls -eq 1) 'Failed final move did not restore debug settings.'
        Assert-NoStaging $f.WorkRoot
    }

    Run-Test 'BAT preserves special-character source path and child exit code' {
        $f = New-Fixture
        $batPath = Join-Path $f.Source 'install.bat'
        [IO.File]::Copy((Join-Path $projectRoot 'install.bat'), $batPath, $true)
        $stub = @'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::WriteLine('SOURCE=' + $env:AI_TOOLBOX_SOURCE)
[Console]::WriteLine('SCRIPTROOT=' + $PSScriptRoot)
exit 7
'@
        $stubPath = Join-Path $f.Source 'scripts\install.ps1'
        [IO.File]::WriteAllText($stubPath, $stub, (New-Object Text.UTF8Encoding($true)))
        $result = Invoke-TestBat $batPath
        Assert-True ($result.ExitCode -eq 7) "BAT lost child exit code: $($result.ExitCode); $($result.Output); $($result.ErrorOutput)"
        Assert-True ($result.Output.Contains('SOURCE=' + $f.Source + '\')) "BAT changed source path: $($result.Output)"
        Assert-True ($result.Output.Contains('SCRIPTROOT=' + (Join-Path $f.Source 'scripts'))) "BAT changed PSScriptRoot: $($result.Output)"
    }

    Run-Test 'BAT rejects missing PowerShell entrypoint with exit code 1' {
        $f = New-Fixture
        $batPath = Join-Path $f.Source 'install.bat'
        [IO.File]::Copy((Join-Path $projectRoot 'install.bat'), $batPath, $true)
        $result = Invoke-TestBat $batPath
        Assert-True ($result.ExitCode -eq 1) "Missing entrypoint returned incorrect exit code: $($result.ExitCode)"
        Assert-True ($result.Output.Contains('Installer files are missing.')) 'Missing entrypoint did not report the problem.'
    }
} finally {
    # Resolve and verify the exact owned absolute path before recursive deletion.
    $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
    $allowedRoot = [IO.Path]::GetFullPath($testsRoot).TrimEnd('\') + '\'
    $expectedName = [IO.Path]::GetFileName($resolvedTestRoot)
    if (!$resolvedTestRoot.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase) -or
        $expectedName -notmatch '^\.installer-[0-9a-f]{32}$') {
        throw "Refusing cleanup outside the owned fixture directory: $resolvedTestRoot"
    }
    # Remove only each junction itself before recursive fixture cleanup. Both ends
    # are owned test paths; never recurse through a fixture link to its target.
    foreach ($junction in $script:junctions) {
        Assert-FixturePath $junction.Link
        Assert-FixturePath $junction.Target
        if ([IO.Directory]::Exists($junction.Link)) {
            $entry = Microsoft.PowerShell.Management\Get-Item -LiteralPath $junction.Link -Force
            if (!($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw "Refusing junction cleanup on an ordinary directory: $($junction.Link)"
            }
            [IO.Directory]::Delete([IO.Path]::GetFullPath($junction.Link))
        }
    }
    if (Test-Path -LiteralPath $resolvedTestRoot) {
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
    }
}

Write-Host "Installer tests: $script:passed passed, $script:failures failed. Adobe settings were mocked."
if ($script:failures -gt 0) { exit 1 }
exit 0
