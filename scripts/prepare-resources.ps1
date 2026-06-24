$ErrorActionPreference = 'Stop'
$resourcesDir = "$PSScriptRoot\..\resources"
New-Item -ItemType Directory -Force -Path $resourcesDir | Out-Null

# ── JRE 21 ────────────────────────────────────────────────────────────────────
$jreDest = "$resourcesDir\jre"
if (Test-Path "$jreDest\bin\java.exe") {
    Write-Host "[OK] JRE already bundled"
} else {
    Write-Host "[...] Downloading Adoptium JRE 21 (~50MB)..."
    $jreUrl = "https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jre/hotspot/normal/eclipse"
    $jreZip = "$env:TEMP\adoptium-jre21.zip"
    Invoke-WebRequest -Uri $jreUrl -OutFile $jreZip -MaximumRedirection 15
    Write-Host "[...] Extracting JRE..."
    $extract = "$env:TEMP\jre21-extract"
    if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
    Expand-Archive -Path $jreZip -DestinationPath $extract
    $inner = Get-ChildItem $extract | Select-Object -First 1
    if (Test-Path $jreDest) { Remove-Item $jreDest -Recurse -Force }
    Move-Item $inner.FullName $jreDest
    Remove-Item $jreZip -Force -ErrorAction SilentlyContinue
    Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "[OK] JRE 21 bundled"
}

# ── Paper 1.21.4 ──────────────────────────────────────────────────────────────
$paperVer  = "1.21.4"
$paperDest = "$resourcesDir\paper-$paperVer.jar"
if (Test-Path $paperDest) {
    Write-Host "[OK] Paper $paperVer already bundled"
} else {
    Write-Host "[...] Downloading Paper $paperVer..."
    $builds = Invoke-RestMethod "https://api.papermc.io/v2/projects/paper/versions/$paperVer/builds"
    $stable = @($builds.builds | Where-Object { $_.channel -eq 'default' })
    $latest = if ($stable.Count -gt 0) { $stable[-1] } else { $builds.builds[-1] }
    $build  = $latest.build
    $jarName   = "paper-$paperVer-$build.jar"
    $paperUrl  = "https://api.papermc.io/v2/projects/paper/versions/$paperVer/builds/$build/downloads/$jarName"
    Invoke-WebRequest -Uri $paperUrl -OutFile $paperDest -MaximumRedirection 5
    Write-Host "[OK] Paper $paperVer (build $build) bundled"
}

Write-Host ""
Write-Host "[DONE] Resources ready for packaging."
