# session-restore saver for Windows (Windows PowerShell 5.1 or later).
#   save.ps1            save a snapshot to ~\.herdr-sessions\auto when something changed
#   save.ps1 -Print     print a fresh snapshot (the popup's view of "now"), store nothing
#   save.ps1 -Enable    run the saver every 5 minutes (scheduled task HerdrSessionAutosave)
#   save.ps1 -Disable   remove that task
#   save.ps1 -Status    {"enabled":..,"lastRun":..,"lastError":".."}
# Records raw facts only (hc output, processes, Claude session files); plan.js decides.
param([switch]$Print, [switch]$Enable, [switch]$Disable, [switch]$Status)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$TaskName = 'HerdrSessionAutosave'
$Store = Join-Path $HOME '.herdr-sessions'
$Auto = Join-Path $Store 'auto'
$Keep = 50
$Utf8 = New-Object System.Text.UTF8Encoding($false)

function Write-Text([string]$Path, [string]$Text) { [System.IO.File]::WriteAllText($Path, $Text, $Utf8) }
function Read-Text([string]$Path) { if (Test-Path -LiteralPath $Path) { [System.IO.File]::ReadAllText($Path) } else { '' } }
function Write-Log([string]$Line) {
    try { [System.IO.File]::AppendAllText((Join-Path $Store 'log.txt'), "$(Get-Date -Format s) $Line`r`n", $Utf8) } catch {}
}

function ConvertTo-JsonString([string]$s) {
    if ($null -eq $s) { return 'null' }
    $b = New-Object System.Text.StringBuilder
    [void]$b.Append('"')
    foreach ($c in $s.ToCharArray()) {
        switch ($c) {
            '"' { [void]$b.Append('\"') }
            '\' { [void]$b.Append('\\') }
            "`n" { [void]$b.Append('\n') }
            "`r" { [void]$b.Append('\r') }
            "`t" { [void]$b.Append('\t') }
            default { if ([int]$c -lt 32) { [void]$b.Append(('\u{0:x4}' -f [int]$c)) } else { [void]$b.Append($c) } }
        }
    }
    [void]$b.Append('"')
    $b.ToString()
}

# Runs hc and returns its stdout text, or $null. A real process with redirected output:
# reliable capture and a timeout, unlike the call operator.
function Invoke-Hc([string[]]$Arguments) {
    try {
        $exe = (Get-Command hc -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
        $psi = New-Object System.Diagnostics.ProcessStartInfo($exe)
        $psi.Arguments = ($Arguments | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.StandardOutputEncoding = $Utf8
        $p = [System.Diagnostics.Process]::Start($psi)
        $err = $p.StandardError.ReadToEndAsync()
        $out = $p.StandardOutput.ReadToEnd()
        if (-not $p.WaitForExit(20000)) { try { $p.Kill() } catch {}; return $null }
        $null = $err.Result
        if ($p.ExitCode -ne 0 -or -not $out.Trim()) { return $null }
        $out.Trim()
    }
    catch { $null }
}

function Get-Snapshot {
    # Returns @{ json; signature } or throws with a reason.
    $lsText = Invoke-Hc @('ls', '--json')
    if (-not $lsText) { throw 'hc ls failed (is herdr-core running?)' }
    $ls = $lsText | ConvertFrom-Json

    $gets = @()
    $roots = @()
    $sigLines = @()
    foreach ($t in @($ls.terminals)) {
        $addr = "$($t.address)"
        if ($t.state -ne 'live' -or $addr -match '/') { continue }
        $text = Invoke-Hc @('get', $addr, '--json')
        if (-not $text) { continue }
        $d = $text | ConvertFrom-Json
        $gets += , @($addr, $text)
        if ($d.pid) { $roots += [int]$d.pid }
        # Only terminals Herdr shows count as a change: hidden workers come and go all day.
        if ($d.labels -and $d.labels.'herdr.space') { $sigLines += "$addr $(@($d.foreground.argv) -join ' ')" }
    }

    $all = @{}
    $children = @{}
    foreach ($p in Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CreationDate, Name, ExecutablePath) {
        $id = [int]$p.ProcessId
        $all[$id] = $p
        $pp = [int]$p.ParentProcessId
        if (-not $children.ContainsKey($pp)) { $children[$pp] = New-Object System.Collections.ArrayList }
        [void]$children[$pp].Add($id)
    }

    # Claude session files of live processes.
    $sessions = @()
    $sessionDir = Join-Path $HOME '.claude\sessions'
    if (Test-Path -LiteralPath $sessionDir) {
        foreach ($f in Get-ChildItem -LiteralPath $sessionDir -Filter '*.json' -File) {
            $sp = 0
            if (-not [int]::TryParse($f.BaseName, [ref]$sp) -or -not $all.ContainsKey($sp)) { continue }
            $text = (Read-Text $f.FullName).Trim()
            try { $s = $text | ConvertFrom-Json } catch { continue }
            $sessions += , @($sp, $text)
            $sigLines += "session $sp $($s.sessionId)"
        }
    }

    # Processes: everything under each terminal, plus every Claude session pid.
    $keep = @{}
    $queue = New-Object System.Collections.Queue
    foreach ($r in $roots) { $queue.Enqueue($r) }
    foreach ($s in $sessions) { $keep[[int]$s[0]] = $true }
    while ($queue.Count) {
        $id = [int]$queue.Dequeue()
        if ($keep[$id] -and -not ($roots -contains $id)) { continue }
        $keep[$id] = $true
        if ($children.ContainsKey($id)) { foreach ($c in $children[$id]) { if (-not $keep[[int]$c]) { $queue.Enqueue($c) } } }
    }
    $procJson = @()
    foreach ($id in $keep.Keys) {
        $p = $all[[int]$id]
        if (-not $p) { continue }
        $start = if ($p.CreationDate) { ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() } else { 0 }
        $procJson += '{"pid":' + $id + ',"ppid":' + [int]$p.ParentProcessId + ',"start":' + $start +
            ',"name":' + (ConvertTo-JsonString $p.Name) + ',"path":' + (ConvertTo-JsonString $p.ExecutablePath) + '}'
    }

    $getJson = ($gets | ForEach-Object { (ConvertTo-JsonString $_[0]) + ':' + $_[1] }) -join ','
    $savedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $json = '{"version":2,"savedAt":' + $savedAt + ',"platform":"windows","ls":' + $lsText +
        ',"get":{' + $getJson + '},"processes":[' + ($procJson -join ',') + '],"sessions":[' +
        (($sessions | ForEach-Object { $_[1] }) -join ',') + ']}'
    @{ json = $json; signature = (($sigLines | Sort-Object) -join "`n"); terminals = $gets.Count; claude = $sessions.Count }
}

function Save-Snapshot {
    New-Item -ItemType Directory -Force $Auto | Out-Null
    Write-Text (Join-Path $Store 'last.run') ([string][DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
    try { $snap = Get-Snapshot }
    catch {
        Write-Text (Join-Path $Store 'last.error') "$($_.Exception.Message)"
        Write-Log "error: $($_.Exception.Message)"
        return $false
    }
    Write-Text (Join-Path $Store 'last.error') ''
    $sigPath = Join-Path $Store 'last.sig'
    $files = @(Get-ChildItem -LiteralPath $Auto -Filter '*.json' -File | Sort-Object Name -Descending)
    if ($files.Count -and (Read-Text $sigPath) -eq $snap.signature) {
        $files[0].LastWriteTime = Get-Date
        Write-Log "unchanged: $($snap.terminals) terminals, $($snap.claude) sessions"
        return $true
    }
    $name = "$(Get-Date -Format yyyyMMdd-HHmmss).json"
    Write-Text (Join-Path $Auto $name) $snap.json
    Write-Text $sigPath $snap.signature
    $files = @(Get-ChildItem -LiteralPath $Auto -Filter '*.json' -File | Sort-Object Name -Descending)
    if ($files.Count -gt $Keep) { $files[$Keep..($files.Count - 1)] | Remove-Item -Force }
    Write-Log "saved $($name): $($snap.terminals) terminals, $($snap.claude) sessions"
    return $true
}

if ($Print) {
    try { [Console]::Out.Write((Get-Snapshot).json) } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
    exit 0
}
if ($Enable) {
    New-Item -ItemType Directory -Force $Store | Out-Null
    $action = New-ScheduledTaskAction -Execute 'conhost.exe' `
        -Argument "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
        -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force `
        -Description 'Saves which Claude Code session runs in which Herdr terminal (session-restore mod).' | Out-Null
    Write-Log 'autosave enabled'
    # The task is on even if this first save fails (say herdr-core is down); -Status
    # shows that failure as lastError.
    $null = Save-Snapshot
    exit 0
}
if ($Disable) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
    Write-Log 'autosave disabled'
    exit 0
}
if ($Status) {
    $enabled = [bool](Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
    $run = (Read-Text (Join-Path $Store 'last.run')).Trim()
    $lastRun = if ($run -match '^\d+$') { [string]([long]$run * 1000) } else { 'null' }
    $err = (Read-Text (Join-Path $Store 'last.error')).Trim()
    [Console]::Out.Write('{"enabled":' + $enabled.ToString().ToLower() + ',"lastRun":' + $lastRun + ',"lastError":' + (ConvertTo-JsonString $err) + '}')
    exit 0
}
if (-not (Save-Snapshot)) { exit 1 }
