[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$localRoot = Join-Path $projectRoot '.local'
$environmentNames = @('TEMP', 'TMP', 'npm_config_cache', 'PYTHONPYCACHEPREFIX')
$originalEnvironment = @{}
foreach ($name in $environmentNames) {
    $originalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

try {
    foreach ($directory in @('temp', 'npm-cache', 'pycache')) {
        New-Item -ItemType Directory -Path (Join-Path $localRoot $directory) -Force | Out-Null
    }
    [Environment]::SetEnvironmentVariable('TEMP', (Join-Path $localRoot 'temp'), 'Process')
    [Environment]::SetEnvironmentVariable('TMP', (Join-Path $localRoot 'temp'), 'Process')
    [Environment]::SetEnvironmentVariable('npm_config_cache', (Join-Path $localRoot 'npm-cache'), 'Process')
    [Environment]::SetEnvironmentVariable('PYTHONPYCACHEPREFIX', (Join-Path $localRoot 'pycache'), 'Process')

    $node = Get-Command node -ErrorAction Stop
    $npm = Get-Command npm.cmd -ErrorAction Stop
    $python = Get-Command python -ErrorAction Stop
    & $node.Source -e "const [a,b]=process.versions.node.split('.').map(Number); if(a<22||(a===22&&b<12)) process.exit(1)"
    if ($LASTEXITCODE -ne 0) { throw 'Node.js 22.12 atau lebih baru diperlukan.' }
    & $python.Source -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)"
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.9 atau lebih baru diperlukan.' }

    Push-Location $projectRoot
    try {
        if (-not (Test-Path -LiteralPath 'package-lock.json' -PathType Leaf)) {
            throw 'package-lock.json tidak ditemukan. Gunakan salinan proyek yang lengkap.'
        }

        $dependencyCheck = @'
const fs = require('node:fs');
try {
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  const installed = JSON.parse(fs.readFileSync('node_modules/.package-lock.json', 'utf8'));
  const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const expected = { ...manifest.dependencies, ...manifest.devDependencies };
  for (const [name, version] of Object.entries(expected)) {
    const actual = JSON.parse(fs.readFileSync(`node_modules/${name}/package.json`, 'utf8'));
    if (actual.version !== version) process.exit(1);
  }
  for (const [name, item] of Object.entries(installed.packages)) {
    const pinned = lock.packages[name];
    if (!pinned || ['version', 'resolved', 'integrity'].some(key => pinned[key] !== item[key])) process.exit(1);
  }
  for (const [name, item] of Object.entries(lock.packages)) {
    if (name && !item.optional && !installed.packages[name]) process.exit(1);
  }
} catch { process.exit(1); }
'@
        & $node.Source -e $dependencyCheck
        if ($LASTEXITCODE -ne 0) {
            Write-Host 'Menyiapkan dependensi lokal dari package-lock.json...'
            & $npm.Source ci --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw 'npm ci gagal. Periksa sambungan internet dan keluaran di atas.' }
        }

        & $npm.Source run build
        if ($LASTEXITCODE -ne 0) { throw 'Build gagal. Periksa keluaran di atas.' }

        Write-Host 'Buka http://127.0.0.1:8124 di browser. Tekan Ctrl+C untuk berhenti.'
        & $python.Source (Join-Path $PSScriptRoot 'serve.py') --port 8124
        if ($LASTEXITCODE -ne 0) { throw 'Server berhenti dengan kesalahan. Pastikan port 8124 tersedia.' }
    }
    finally {
        Pop-Location
    }
}
finally {
    foreach ($name in $environmentNames) {
        [Environment]::SetEnvironmentVariable($name, $originalEnvironment[$name], 'Process')
    }
}
