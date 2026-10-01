param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Status', 'Read', 'Setup', 'Remove')]
  [string] $Operation,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^Sheg/(Jev/(TypeSafe|OpenRouter)|Test/[0-9a-f-]{36})$')]
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

function ConvertFrom-ShegCredentialBlob {
  param([Parameter(Mandatory = $true)] $Credential)

  $size = [int64]$Credential.CredentialBlobSize
  if ($size -le 0 -or $size -gt 5120 -or $Credential.CredentialBlob -eq [IntPtr]::Zero) {
    throw [FormatException]::new('The stored credential format is unsupported.')
  }

  $bytes = [byte[]]::new([int]$size)
  try {
    for ($index = 0; $index -lt $bytes.Length; $index++) {
      $bytes[$index] = [Runtime.InteropServices.Marshal]::ReadByte($Credential.CredentialBlob, $index)
    }

    # Credential Manager stores generic blobs as opaque bytes. Accept a safe
    # UTF-8 token directly (including odd byte lengths) before trying the
    # UTF-16LE representation written by Sheg's own setup command.
    try {
      $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
      $utf8Value = $utf8.GetString($bytes)
      if ($utf8Value.Length -gt 0 -and $utf8Value -notmatch '[\x00-\x1f\x7f]') { return $utf8Value }
    }
    catch { }

    if (($bytes.Length % 2) -eq 0) {
      try {
        $utf16 = [System.Text.UnicodeEncoding]::new($false, $false, $true)
        $utf16Value = $utf16.GetString($bytes)
        if ($utf16Value.Length -gt 0 -and $utf16Value -notmatch '[\x00-\x1f\x7f]') { return $utf16Value }
      }
      catch { }
    }
    throw [FormatException]::new('The stored credential format is unsupported.')
  }
  finally { [Array]::Clear($bytes, 0, $bytes.Length) }
}

switch ($Operation) {
  'Status' {
    $nativeCredential = [IntPtr]::Zero
    if ([ShegCredentialApi]::CredRead($TargetName, $credentialTypeGeneric, 0, [ref] $nativeCredential)) {
      try {
        $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($nativeCredential, [type][ShegCredential])
        $null = ConvertFrom-ShegCredentialBlob $credential
        [Console]::Out.WriteLine('AVAILABLE')
        exit 0
      }
      catch [FormatException] {
        [Console]::Out.WriteLine('MALFORMED')
        exit 4
      }
      finally { [ShegCredentialApi]::CredFree($nativeCredential) }
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
      $value = ConvertFrom-ShegCredentialBlob $credential
      [Console]::Out.Write($value)
      $value = $null
    }
    catch [FormatException] {
      [Console]::Out.WriteLine('MALFORMED')
      exit 4
    }
    finally {
      [ShegCredentialApi]::CredFree($nativeCredential)
    }
    exit 0
  }
  'Setup' {
    $securePassword = Read-Host "Enter the API key for $TargetName" -AsSecureString
    if ($securePassword.Length -eq 0) { $securePassword.Dispose(); exit 1 }
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
