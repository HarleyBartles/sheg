param(
  [switch] $RawUtf8Bytes,
  [switch] $RawInvalidBytes,

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
if ($RawUtf8Bytes -or $RawInvalidBytes) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct ShegFixtureCredential {
  public UInt32 Flags; public UInt32 Type; public string TargetName; public string Comment;
  public long LastWritten; public UInt32 CredentialBlobSize; public IntPtr CredentialBlob;
  public UInt32 Persist; public UInt32 AttributeCount; public IntPtr Attributes;
  public string TargetAlias; public string UserName;
}
public static class ShegFixtureCredentialApi {
  [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredWrite(ref ShegFixtureCredential credential, UInt32 flags);
  [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredDelete(string target, UInt32 type, UInt32 flags);
}
'@
  $raw = [Console]::In.ReadLine()
  $bytes = if ($RawInvalidBytes) { [byte[]]@(0xff, 0xfe, 0xfd) } else { [Text.Encoding]::UTF8.GetBytes($raw) }
  $blob = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
  try {
    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
    $credential = [ShegFixtureCredential]::new()
    $credential.Type = 1
    $credential.TargetName = $TargetName
    $credential.UserName = [Environment]::UserName
    $credential.CredentialBlobSize = [uint32]$bytes.Length
    $credential.CredentialBlob = $blob
    $credential.Persist = 2
    if (-not [ShegFixtureCredentialApi]::CredWrite([ref] $credential, 0)) { throw 'Fixture credential could not be written.' }
  }
  finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($blob); [Array]::Clear($bytes, 0, $bytes.Length) }
  exit 0
}
& (Join-Path $PSScriptRoot '../../src/infrastructure/credentials/windows-credential.ps1') -Operation Setup -TargetName $TargetName
exit $LASTEXITCODE
