# hey-claude listener for Windows: the same line protocol as listener/main.swift, built on
# Windows' own offline speech recognizer (System.Speech). Nothing to build: Windows
# PowerShell 5.1, on every Windows 10 and 11, runs it.
#
# Writes to stdout, one per line: ready, busy, wake, heard<TAB>text, miss<TAB>text,
# prompt<TAB>text, cancelled, stop, idle. Errors go to stderr as "error: ...".
param(
    [string]$Log = '',
    [string]$Speaking = '',
    [string]$Owner = '',
    [string]$Id = '',
    [string]$Cancel = '',
    [string]$Locale = 'en-US',
    [double]$Silence = 4,          # seconds of quiet that send the request
    [double]$FirstWord = 8,        # seconds to start talking after the wake phrase
    [double]$MinConfidence = 0.5,  # how sure the recognizer must be of the wake phrase
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$Greetings = 'hey', 'hi', 'okay', 'ok', 'hello'
$WakeRegex = '^\s*((hey|hi|okay|ok|hello)[\s,]+)?claude\b[\s,.!?]*'

# The request after the wake phrase, or $null when the text does not start with it.
function Get-Request([string]$text) {
    if ($text -notmatch $WakeRegex) { return $null }
    return ($text -replace $WakeRegex, '').Trim()
}
# A request ending in "cancel", "never mind" or "forget it" is dropped.
function Test-Cancel([string]$cmd) { return $cmd.ToLower() -match '(^|\s)(cancel|never ?mind|forget it)[.!]?$' }
function Test-Bare([string]$text) { return $text -match '^\s*claude\b' }

if ($SelfTest) {
    if ((Get-Request 'Hey Claude what time is it') -ne 'what time is it') { throw 'wake 1' }
    if ((Get-Request 'Claude, stop') -ne 'stop') { throw 'wake 2' }
    if ((Get-Request 'hey claude') -ne '') { throw 'wake 3' }
    if ($null -ne (Get-Request 'I asked Claude about it')) { throw 'mid-sentence' }
    if (-not (Test-Cancel 'open the file never mind')) { throw 'cancel 1' }
    if (Test-Cancel 'cancel my meeting at noon') { throw 'cancel 2' }
    'selftest ok'
    exit 0
}

function Emit([string]$line) {
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
    Trace $line
}
$script:tracing = $false
function Trace([string]$line) {
    if ($Log -and $script:tracing) {
        try { Add-Content -LiteralPath $Log -Value ("{0:HH:mm:ss.fff} {1}" -f (Get-Date), $line) -Encoding UTF8 } catch {}
    }
}
function Fail([string]$msg) {
    [Console]::Error.WriteLine("error: $msg")
    exit 2
}
function MTime([string]$path) {
    if (-not $path -or -not (Test-Path -LiteralPath $path)) { return [datetime]::MinValue }
    return (Get-Item -LiteralPath $path).LastWriteTimeUtc
}
# Claude is speaking a summary, or stopped less than 1.5 s ago (its echo).
function Test-Speaking {
    if (-not $Speaking -or -not (Test-Path -LiteralPath $Speaking)) { return $false }
    $flag = (Get-Content -LiteralPath $Speaking -Raw -ErrorAction SilentlyContinue)
    if ($flag -and $flag.Trim() -eq '1') { return $true }
    return ([datetime]::UtcNow - (MTime $Speaking)).TotalSeconds -lt 1.5
}

# --- recognizer --------------------------------------------------------------------
try { Add-Type -AssemblyName System.Speech } catch { Fail 'Windows speech recognition (System.Speech) is not available.' }
$culture = [Globalization.CultureInfo]::GetCultureInfo($Locale)
$info = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() |
    Where-Object { $_.Culture.Name -eq $culture.Name } | Select-Object -First 1
if (-not $info) {
    Fail "no $Locale speech recognizer is installed. Add it in Settings > Time & language > Speech."
}
$engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($info)
try { $engine.SetInputToDefaultAudioDevice() } catch { Fail "no microphone: $($_.Exception.Message)" }
$engine.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(500)

$names = New-Object System.Speech.Recognition.Choices
foreach ($g in $Greetings) { $names.Add("$g claude") }
$names.Add('claude')
# The wake phrase alone, the wake phrase and a request in one breath, and everything else.
$wake = New-Object System.Speech.Recognition.Grammar((New-Object System.Speech.Recognition.GrammarBuilder($names)))
$wake.Name = 'wake'
$withCmd = New-Object System.Speech.Recognition.GrammarBuilder($names)
$withCmd.AppendDictation()
$wakeCmd = New-Object System.Speech.Recognition.Grammar($withCmd)
$wakeCmd.Name = 'wake'
$free = New-Object System.Speech.Recognition.DictationGrammar
$free.Name = 'free'
$engine.LoadGrammar($wake)
$engine.LoadGrammar($wakeCmd)
$engine.LoadGrammar($free)

Register-ObjectEvent $engine SpeechRecognized -SourceIdentifier said | Out-Null
Register-ObjectEvent $engine SpeechHypothesized -SourceIdentifier hearing | Out-Null

# --- listening ---------------------------------------------------------------------
$script:running = $false
$script:awake = $false
$script:command = ''
$script:lastHeard = ''
$script:since = [datetime]::UtcNow

# The engine starts once and keeps running: restarting it right after a cancel throws.
# A chat without the mic drops what it hears.
$script:engineOn = $false
function Start-Listening {
    if ($script:running) { return }
    if ($Log) { try { [IO.File]::WriteAllText($Log, '') } catch {} }
    $script:tracing = $true
    if (-not $script:engineOn) {
        $engine.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
        $script:engineOn = $true
    }
    $script:running = $true
    $script:sentBusy = $false
    Emit 'ready'
}
function Stop-Listening {
    if (-not $script:running) { return }
    $script:running = $false
    $script:awake = $false
    Emit 'busy'
    $script:tracing = $false
}
function Wake([string]$rest) {
    $script:awake = $true
    $script:command = $rest
    $script:lastHeard = $rest
    $script:since = [datetime]::UtcNow
    Emit 'wake'
    if ($rest) { Emit "heard`t$rest" }
}
function Finish {
    $cmd = $script:command.Trim(' ', '.', ',', '!', '?')
    $script:awake = $false
    $script:command = ''
    if (-not $cmd) { Trace 'heard the wake phrase but no request' }
    elseif ($cmd.ToLower() -eq 'stop') { Emit 'stop' }
    elseif (Test-Cancel $cmd) { Emit 'cancelled' }
    else { Emit ("prompt`t" + ($cmd -replace '\s+', ' ')) }
    Emit 'idle'
}

function On-Said($result) {
    $text = $result.Text
    if (-not $text) { return }
    Trace ("said [{0} {1:N2}] {2}" -f $result.Grammar.Name, $result.Confidence, $text)
    if ($script:awake) {
        $script:command = ($script:command + ' ' + $text).Trim()
        $script:since = [datetime]::UtcNow
        Emit "heard`t$($script:command)"
        return
    }
    $rest = Get-Request $text
    # The wake grammar, or plain dictation that heard a greeting and the name at the start.
    $isWake = $null -ne $rest -and (($result.Grammar.Name -eq 'wake' -and $result.Confidence -ge $MinConfidence) -or -not (Test-Bare $text))
    # Claude reading "Claude" aloud must not wake it; "Hey Claude" still does, to stop it.
    if ($isWake -and (Test-Bare $text) -and (Test-Speaking)) { $isWake = $false }
    if ($isWake) {
        if ($rest -and $rest.ToLower().Trim('.', '!') -eq 'stop') { $script:command = 'stop'; Emit 'wake'; Finish; return }
        Wake $rest
    } else {
        Emit "miss`t$text"
    }
}
function On-Hearing($result) {
    if (-not $script:awake) { return }
    $script:since = [datetime]::UtcNow
    $live = ($script:command + ' ' + $result.Text).Trim()
    if ($live -ne $script:lastHeard) {
        $script:lastHeard = $live
        Emit "heard`t$live"
    }
}

# --- the mic follows the chat in use (owner file), like main.swift -------------------
$script:sentBusy = $false
function Follow-Owner {
    $mine = $true
    if ($Owner) {
        $who = ''
        if (Test-Path -LiteralPath $Owner) { $who = ((Get-Content -LiteralPath $Owner -Raw -ErrorAction SilentlyContinue) + '').Trim() }
        $age = ([datetime]::UtcNow - (MTime $Owner)).TotalSeconds
        if ($who -ne $Id -and (-not $who -or $age -gt 5)) {
            Trace "taking the mic (owner $(if ($who) { $who } else { 'none' }) gone)"
            [IO.File]::WriteAllText($Owner, $Id)
            return  # listen from the next check, after any other claim has landed
        }
        $mine = $who -eq $Id
        if ($mine) { (Get-Item -LiteralPath $Owner).LastWriteTimeUtc = [datetime]::UtcNow }
    }
    if ($mine) { Start-Listening }
    elseif ($script:running) { Stop-Listening }
    elseif (-not $script:sentBusy) { $script:sentBusy = $true; Emit 'busy' }
}

# Ends with Claude: the parent's exit ends the listener.
$parent = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId
$cancelSeen = MTime $Cancel
$nextOwnerCheck = [datetime]::MinValue

while ($true) {
    $ev = Wait-Event -Timeout 0.25
    if ($ev) {
        Remove-Event -EventIdentifier $ev.EventIdentifier
        if ($script:running) {
            if ($ev.SourceIdentifier -eq 'said') { On-Said $ev.SourceEventArgs.Result }
            elseif ($ev.SourceIdentifier -eq 'hearing') { On-Hearing $ev.SourceEventArgs.Result }
        }
    }
    $now = [datetime]::UtcNow
    if ($now -ge $nextOwnerCheck) {
        $nextOwnerCheck = $now.AddSeconds(1)
        if (-not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) { exit 0 }
        Follow-Owner
    }
    # The Cancel button touches the cancel file.
    $c = MTime $Cancel
    if ($c -ne $cancelSeen) {
        $cancelSeen = $c
        if ($script:awake) { $script:awake = $false; $script:command = ''; Emit 'cancelled'; Emit 'idle' }
    }
    if ($script:awake) {
        $quiet = ($now - $script:since).TotalSeconds
        if ($script:command -and $quiet -ge $Silence) { Finish }
        elseif (-not $script:command -and $quiet -ge $FirstWord) { $script:awake = $false; Emit 'idle' }
    }
}
