param(
  [Parameter(Mandatory = $true)] [ValidateSet('Status', 'Read', 'Remove', 'WriteFixture')] [string] $Operation,
  [Parameter(Mandatory = $true)] [string] $TargetName
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
if ($TargetName -notmatch '^Sheg/Test/[0-9a-f-]{36}$') { exit 2 }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
public struct FixtureCredential { public UInt32 Flags; public UInt32 Type; public string TargetName; public string Comment; public long LastWritten; public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist; public UInt32 AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
public static class FixtureCredentialApi {
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredWrite(ref FixtureCredential credential, UInt32 flags);
  [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredDelete(string target, UInt32 type, UInt32 flags);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr credential);
}
'@
$generic = 1
$missing = 1168
switch ($Operation) {
  'Status' {
    $pointer = [IntPtr]::Zero
    if ([FixtureCredentialApi]::CredRead($TargetName, $generic, 0, [ref] $pointer)) { [FixtureCredentialApi]::CredFree($pointer); [Console]::Out.WriteLine('AVAILABLE'); exit 0 }
    if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq $missing) { [Console]::Out.WriteLine('MISSING'); exit 3 }
    exit 1
  }
  'Read' {
    $pointer = [IntPtr]::Zero
    if (-not [FixtureCredentialApi]::CredRead($TargetName, $generic, 0, [ref] $pointer)) { exit 1 }
    try {
      $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($pointer, [type][FixtureCredential])
      $length = [int]($credential.CredentialBlobSize / 2)
      $characters = [char[]]::new($length)
      try { for ($index = 0; $index -lt $length; $index++) { $characters[$index] = [char]([Runtime.InteropServices.Marshal]::ReadInt16($credential.CredentialBlob, $index * 2) -band 0xffff) }; [Console]::Out.Write([string]::new($characters)) }
      finally { [Array]::Clear($characters, 0, $characters.Length) }
    }
    finally { [FixtureCredentialApi]::CredFree($pointer) }
    exit 0
  }
  'WriteFixture' {
    $fixtureValue = [Console]::In.ReadLine()
    if ([string]::IsNullOrEmpty($fixtureValue)) { exit 1 }
    $secure = [Security.SecureString]::new()
    foreach ($character in $fixtureValue.ToCharArray()) { $secure.AppendChar($character) }
    $fixtureValue = $null
    $blob = [Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($secure)
    try {
      $credential = [FixtureCredential]::new()
      $credential.Type = $generic; $credential.TargetName = $TargetName; $credential.UserName = [Environment]::UserName
      $credential.CredentialBlob = $blob; $credential.CredentialBlobSize = [uint32]($secure.Length * 2); $credential.Persist = 2
      if (-not [FixtureCredentialApi]::CredWrite([ref] $credential, 0)) { exit 1 }
    }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($blob); $secure.Dispose() }
    exit 0
  }
  'Remove' {
    if ([FixtureCredentialApi]::CredDelete($TargetName, $generic, 0)) { exit 0 }
    if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq $missing) { exit 3 }
    exit 1
  }
}
