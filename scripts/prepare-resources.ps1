param([string]$MinecraftVersion = '26.3', [int]$JavaMajor = 25)
$ErrorActionPreference = 'Stop'
$downloadHeaders = @{ 'User-Agent' = 'MC-DevKit/1.8.0 (https://github.com/hongseongug812-ui/mc-devkit)' }
$resourcesDir = "$PSScriptRoot\..\resources"
New-Item -ItemType Directory -Force -Path $resourcesDir | Out-Null

# ── Java runtime ─────────────────────────────────────────────────────────────
$jreDest = "$resourcesDir\jre"
if (Test-Path "$jreDest\bin\java.exe") {
    Write-Host "[OK] JRE already bundled"
} else {
    Write-Host "[...] Downloading Adoptium JRE $JavaMajor..."
    $jreUrl = "https://api.adoptium.net/v3/binary/latest/$JavaMajor/ga/windows/x64/jre/hotspot/normal/eclipse"
    $jreZip = "$resourcesDir\adoptium-jre-$JavaMajor.zip"
    Invoke-WebRequest -Uri $jreUrl -OutFile $jreZip -MaximumRedirection 15
    Write-Host "[...] Extracting JRE..."
    $extract = "$resourcesDir\jre-extract-$([Guid]::NewGuid().ToString('N'))"
    Expand-Archive -Path $jreZip -DestinationPath $extract
    $inner = Get-ChildItem $extract | Select-Object -First 1
    Move-Item $inner.FullName $jreDest
    Remove-Item $jreZip -Force -ErrorAction SilentlyContinue
    $resolvedExtract = [IO.Path]::GetFullPath($extract)
    $resolvedResources = [IO.Path]::GetFullPath($resourcesDir)
    if (-not $resolvedExtract.StartsWith($resolvedResources + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid extraction path' }
    Remove-Item -LiteralPath $resolvedExtract -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "[OK] JRE $JavaMajor bundled"
}

# ── Stable Paper, verified by SHA-256 ──────────────────────────────────────────
$paperVer = $MinecraftVersion
$paperDest = "$resourcesDir\paper-$paperVer.jar"
if (Test-Path $paperDest) {
    Write-Host "[OK] Paper $paperVer already bundled"
} else {
    Write-Host "[...] Downloading Paper $paperVer..."
    $builds = Invoke-RestMethod -Uri "https://fill.papermc.io/v3/projects/paper/versions/$paperVer/builds" -Headers $downloadHeaders
    $latest = $builds | Where-Object { $_.channel -eq 'STABLE' } | Sort-Object id -Descending | Select-Object -First 1
    if (-not $latest) { throw "No stable build for Paper $paperVer" }
    $build = $latest.id
    $download = $latest.downloads.'server:default'
    $partial = "$paperDest.download"
    Invoke-WebRequest -Uri $download.url -Headers $downloadHeaders -OutFile $partial -MaximumRedirection 5
    $expectedHash = $download.checksums.sha256
    if (-not $expectedHash) { $expectedHash = $download.sha256 }
    if (-not $expectedHash -or (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash.ToLowerInvariant()) { throw 'Paper checksum mismatch' }
    Move-Item -LiteralPath $partial -Destination $paperDest
    Write-Host "[OK] Paper $paperVer (build $build) bundled"
}

Write-Host ""
Write-Host "[DONE] Resources ready for packaging."
