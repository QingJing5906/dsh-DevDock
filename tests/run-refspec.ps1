# Fixture launcher for verify-push-refspec.mjs.
#
# The real test asserts git ARGV, but building the fixture from inside Node is
# impossible in this sandbox: spawnSync/execFile need pipes, which it denies
# (`spawn EPERM`). PowerShell's own git invocations are unaffected, so the
# fixture is created here and the Node test only inspects argv.
#
# Usage: pwsh -File tests/run-refspec.ps1
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$repo = Join-Path ([System.IO.Path]::GetTempPath()) ("refspec-" + [guid]::NewGuid().ToString('N').Substring(0,8))

try {
  New-Item -ItemType Directory -Force -Path $repo | Out-Null
  Push-Location $repo
  git init -q | Out-Null
  git config user.email 't@t.t'
  git config user.name 'T'
  Set-Content -Path a.txt -Value 'a' -NoNewline
  git add -A | Out-Null
  git commit -q -m 'first' | Out-Null
  Set-Content -Path b.txt -Value 'b' -NoNewline
  git add -A | Out-Null
  git commit -q -m 'second' | Out-Null
  git tag v1.0 | Out-Null
  $sha = (git rev-parse HEAD~1).Trim()
  $branch = (git rev-parse --abbrev-ref HEAD).Trim()
  git remote add origin 'https://github.com/alice/demo.git' | Out-Null
  Pop-Location

  Push-Location $root
  node tests/verify-push-refspec.mjs $repo $sha $branch
  $code = $LASTEXITCODE
  Pop-Location
  exit $code
}
finally {
  if (Test-Path $repo) { Remove-Item -Recurse -Force $repo -ErrorAction SilentlyContinue }
}
