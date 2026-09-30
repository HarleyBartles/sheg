param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Status', 'Read', 'Setup', 'Remove')]
  [string] $Operation,

  [Parameter(Mandatory = $true)]
  [ValidateSet('Sheg/Jev/TypeSafe', 'Sheg/Jev/OpenRouter')]
  [string] $TargetName
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct ShegCredential {
  public UInt32 Flags;
  public UInt32 Type;
  public string TargetName;
  public string Comment;
  public long LastWritten;
  public UInt32 CredentialBlobSize;
  public IntPtr CredentialBlob;
  public UInt32 Persist;
  public UInt32 AttributeCount;
  public IntPtr Attributes;
  public string TargetAlias;
  public string UserName;
}

public static class ShegCredentialApi {
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredWrite(ref ShegCredential credential, UInt32 flags);
  [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredDelete(string target, UInt32 type, UInt32 flags);
  [DllImport("advapi32.dll")]
  public static extern void CredFree(IntPtr credential);
}
'@

$credentialTypeGeneric = 1
$credentialPersistLocalMachine = 2
$missingCredential = 1168

switch ($Operation) {
  'Status' {
    $nativeCredential = [IntPtr]::Zero
    if ([ShegCredentialApi]::CredRead($TargetName, $credentialTypeGeneric, 0, [ref] $nativeCredential)) {
      [ShegCredentialApi]::CredFree($nativeCredential)
      [Console]::Out.WriteLine('AVAILABLE')
      exit 0
    }
    if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq $missingCredential) {
      [Console]::Out.WriteLine('MISSING')
      exit 3
    }
    exit 1
  }
  'Read' {
    $nativeCredential = [IntPtr]::Zero
    if (-not [ShegCredentialApi]::CredRead($TargetName, $credentialTypeGeneric, 0, [ref] $nativeCredential)) { exit 1 }
    try {
      $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($nativeCredential, [type][ShegCredential])
      if ($credential.CredentialBlobSize -eq 0 -or ($credential.CredentialBlobSize % 2) -ne 0) { exit 1 }
      $length = [int]($credential.CredentialBlobSize / 2)
      $characters = [char[]]::new($length)
      try {
        for ($index = 0; $index -lt $length; $index++) {
          $characters[$index] = [char][Runtime.InteropServices.Marshal]::ReadInt16($credential.CredentialBlob, $index * 2)
        }
        [Console]::Out.Write([string]::new($characters))
      }
      finally {
        [Array]::Clear($characters, 0, $characters.Length)
      }
    }
    finally {
      [ShegCredentialApi]::CredFree($nativeCredential)
    }
    exit 0
  }
  'Setup' {
    $securePassword = Read-Host "Enter the API key for $TargetName" -AsSecureString
    if ($securePassword.Length -eq 0) { exit 1 }
    $credentialBlob = [Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($securePassword)
    try {
      $credential = [ShegCredential]::new()
      $credential.Type = $credentialTypeGeneric
      $credential.TargetName = $TargetName
      $credential.UserName = [Environment]::UserName
      $credential.CredentialBlob = $credentialBlob
      $credential.CredentialBlobSize = [uint32]($securePassword.Length * 2)
      $credential.Persist = $credentialPersistLocalMachine
      if (-not [ShegCredentialApi]::CredWrite([ref] $credential, 0)) { exit 1 }
      [Console]::Out.WriteLine("Saved $TargetName in Windows Credential Manager.")
    }
    finally {
      [Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($credentialBlob)
      $securePassword.Dispose()
    }
    exit 0
  }
  'Remove' {
    if ([ShegCredentialApi]::CredDelete($TargetName, $credentialTypeGeneric, 0)) { exit 0 }
    if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq $missingCredential) { exit 3 }
    exit 1
  }
}
