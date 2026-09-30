param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^Sheg/Test/[0-9a-f-]{36}$')]
  [string] $TargetName
)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
# Replace only the interactive entry surface. Production Setup and native APIs run unchanged.
function Read-Host {
  param([string] $Prompt, [switch] $AsSecureString)
  if (-not $AsSecureString) { throw 'Fixture requires hidden-input setup.' }
  $fixtureValue = [Console]::In.ReadLine()
  $secure = [Security.SecureString]::new()
  foreach ($character in $fixtureValue.ToCharArray()) { $secure.AppendChar($character) }
  $fixtureValue = $null
  return $secure
}
& (Join-Path $PSScriptRoot '../../src/infrastructure/credentials/windows-credential.ps1') -Operation Setup -TargetName $TargetName
exit $LASTEXITCODE
