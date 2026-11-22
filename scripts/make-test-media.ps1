# Builds the test media for the suites, in a temp folder (never the user's own media):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\make-test-media.ps1 [outDir]
# test-clip.mp4 (12 s 1080p testsrc2 with the English speech, so captions have words), test-music.mp3 (20 s), and speech-he / speech-en (.wav and .mp4):
# three spoken sentences separated by silences of known length, described in speech-*.json
# (segment start/end times and the words), so transcription and silence removal have an exact expected result.
param([string]$Out = (Join-Path $env:TEMP 'alon-test-media'))
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
function ff { & ffmpeg -hide_banner -loglevel error -y @args; if ($LASTEXITCODE) { throw "ffmpeg failed: $args" } }

ff -f lavfi -i 'sine=f=220:d=20' '-c:a' libmp3lame (Join-Path $Out 'test-music.mp3')

# Windows OneCore voices (the Hebrew voice is not visible to System.Speech), through WinRT
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
function Await($op, [type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $null = $task.Wait(-1); $task.Result }

function Speak([string]$lang, [string]$text, [string]$file) {
  $synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
  $voice = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.Language -eq $lang } | Select-Object -First 1
  if (-not $voice) {
    # fall back to the classic SAPI voices (English "Zira" ships with every Windows)
    Add-Type -AssemblyName System.Speech
    $sapi = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $v = $sapi.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq $lang } | Select-Object -First 1
    if (-not $v) { throw "no $lang voice installed" }
    $sapi.SelectVoice($v.VoiceInfo.Name)
    $sapi.SetOutputToWaveFile($file)
    $sapi.Speak($text)
    $sapi.Dispose()
    return
  }
  $synth.Voice = $voice
  $stream = Await ($synth.SynthesizeTextToStreamAsync($text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
  $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
  $n = [uint32]$stream.Size
  $null = Await ($reader.LoadAsync($n)) ([uint32])
  $bytes = New-Object byte[] $n
  $reader.ReadBytes($bytes)
  [IO.File]::WriteAllBytes($file, $bytes)
}

function Probe([string]$file) { [double](& ffprobe -v error -show_entries format=duration -of csv=p=0 $file) }

$sets = @{
  he = @{ lang = 'he-IL'; lines = @('שלום וברוכים הבאים לסטודיו', 'היום נלמד לערוך סרטון קצר', 'תודה רבה ולהתראות') }
  en = @{ lang = 'en-US'; lines = @('Hello and welcome to the studio', 'Today we will edit a short video', 'Thank you and goodbye') }
}
$lead = 0.5; $gaps = @(1.5, 2.0); $tail = 0.5
foreach ($key in $sets.Keys) {
  $set = $sets[$key]; $parts = @(); $segments = @(); $t = $lead
  $tmp = Join-Path $Out "tmp-$key"; New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  ff -f lavfi -i "anullsrc=r=48000:cl=mono" -t $lead '-c:a' pcm_s16le (Join-Path $tmp 'sil-lead.wav')
  $parts += (Join-Path $tmp 'sil-lead.wav')
  for ($i = 0; $i -lt $set.lines.Count; $i++) {
    $raw = Join-Path $tmp "raw$i.wav"; $seg = Join-Path $tmp "seg$i.wav"
    Speak $set.lang $set.lines[$i] $raw
    # trim the voice's own leading/trailing silence so the gaps are exactly the ones we add
    ff -i $raw -af 'aresample=48000,silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse' -ac 1 '-c:a' pcm_s16le $seg
    $d = Probe $seg
    $segments += [ordered]@{ start = [math]::Round($t, 3); end = [math]::Round($t + $d, 3); text = $set.lines[$i] }
    $t += $d; $parts += $seg
    $gap = if ($i -lt $gaps.Count) { $gaps[$i] } else { $tail }
    $sil = Join-Path $tmp "sil$i.wav"
    ff -f lavfi -i "anullsrc=r=48000:cl=mono" -t $gap '-c:a' pcm_s16le $sil
    $parts += $sil; $t += $gap
  }
  $list = Join-Path $tmp 'list.txt'
  ($parts | ForEach-Object { "file '" + ($_ -replace "'", "'\''") + "'" }) | Set-Content -Path $list -Encoding ascii
  $wav = Join-Path $Out "speech-$key.wav"; $mp4 = Join-Path $Out "speech-$key.mp4"
  ff -f concat -safe 0 -i $list '-c:a' pcm_s16le $wav
  $total = Probe $wav
  ff -f lavfi -i "testsrc2=s=1280x720:r=30:d=$total" -i $wav '-c:v' libx264 -pix_fmt yuv420p '-c:a' aac -shortest $mp4
  [ordered]@{ language = $key; duration = [math]::Round($total, 3); lead = $lead; gaps = $gaps; tail = $tail; segments = $segments } |
    ConvertTo-Json -Depth 4 | Out-File -FilePath (Join-Path $Out "speech-$key.json") -Encoding utf8
  Remove-Item -Recurse -Force $tmp
}
ff -f lavfi -i 'testsrc2=s=1920x1080:r=30:d=12' -i (Join-Path $Out 'speech-en.wav') -af 'apad,atrim=0:12' '-c:v' libx264 -pix_fmt yuv420p '-c:a' aac -ar 48000 -t 12 (Join-Path $Out 'test-clip.mp4')
Get-ChildItem $Out | Select-Object Name, Length | Format-Table -AutoSize
