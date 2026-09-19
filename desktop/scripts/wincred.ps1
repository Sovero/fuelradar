# Generic credential store/read for Windows Credential Manager.
#
# Why: the update feed token must not sit as a file inside the repository working
# copy. The OS store encrypts it on disk, binds it to the user, and the desktop
# build can read it (desktop/scripts/feed-token.cjs).
#
# The secret is never passed as an argument: in "write" mode it is read from
# stdin (so it leaks neither into the process list nor into shell history), in
# "read" mode it is written to stdout and never logged anywhere.
#
# This file is intentionally ASCII-only: Windows PowerShell 5.1 decodes .ps1 as
# ANSI unless the file carries a BOM, which mangles non-ASCII text and can break
# parsing. Human-readable Russian messages are produced by the Node layer.
#
# Exit codes: 0 success; 2 empty secret; 3 entry not found; otherwise the Win32
# error code from GetLastError.

param(
  [Parameter(Mandatory = $true)][ValidateSet("read", "write", "delete")][string]$Mode,
  [string]$Target = "FuelRadar/update-feed-token"
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class FuelRadarWinCred
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL
    {
        public int Flags;
        public int Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredReadW(string target, int type, int flags, out IntPtr credential);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredWriteW(ref CREDENTIAL credential, int flags);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredDeleteW(string target, int type, int flags);

    [DllImport("advapi32.dll")]
    public static extern void CredFree(IntPtr buffer);
}
"@

$CRED_TYPE_GENERIC = 1
$CRED_PERSIST_LOCAL_MACHINE = 2
$ERROR_NOT_FOUND = 1168

if ($Mode -eq "delete") {
  if (-not [FuelRadarWinCred]::CredDeleteW($Target, $CRED_TYPE_GENERIC, 0)) {
    $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($code -eq $ERROR_NOT_FOUND) {
      [Console]::Error.WriteLine("credential '$Target' not found")
      exit 3
    }
    [Console]::Error.WriteLine("CredDelete failed for '$Target' (Win32 $code)")
    exit $code
  }
  [Console]::Out.Write("ok")
  exit 0
}

if ($Mode -eq "read") {
  $ptr = [IntPtr]::Zero
  if (-not [FuelRadarWinCred]::CredReadW($Target, $CRED_TYPE_GENERIC, 0, [ref]$ptr)) {
    $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($code -eq $ERROR_NOT_FOUND) {
      [Console]::Error.WriteLine("credential '$Target' not found")
      exit 3
    }
    [Console]::Error.WriteLine("CredRead failed for '$Target' (Win32 $code)")
    exit $code
  }

  try {
    $credential = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][FuelRadarWinCred+CREDENTIAL])
    $bytes = New-Object byte[] $credential.CredentialBlobSize
    if ($credential.CredentialBlobSize -gt 0) {
      [System.Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $credential.CredentialBlobSize)
    }
    [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($bytes))
  } finally {
    [FuelRadarWinCred]::CredFree($ptr)
  }
  exit 0
}

$secret = [Console]::In.ReadToEnd().Trim()
if ([string]::IsNullOrWhiteSpace($secret)) {
  [Console]::Error.WriteLine("empty secret: nothing written")
  exit 2
}

$secretBytes = [System.Text.Encoding]::UTF8.GetBytes($secret)
$blob = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($secretBytes.Length)
try {
  [System.Runtime.InteropServices.Marshal]::Copy($secretBytes, 0, $blob, $secretBytes.Length)

  $credential = New-Object FuelRadarWinCred+CREDENTIAL
  $credential.Type = $CRED_TYPE_GENERIC
  $credential.TargetName = $Target
  $credential.UserName = "update-feed-token"
  $credential.CredentialBlobSize = $secretBytes.Length
  $credential.CredentialBlob = $blob
  $credential.Persist = $CRED_PERSIST_LOCAL_MACHINE

  if (-not [FuelRadarWinCred]::CredWriteW([ref]$credential, 0)) {
    $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    [Console]::Error.WriteLine("CredWrite failed for '$Target' (Win32 $code)")
    exit $code
  }
} finally {
  [System.Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($blob)
}

[Console]::Out.Write("ok")
exit 0
