$ErrorActionPreference = 'Stop'

$name = Read-Host 'Demo owner name'
$email = Read-Host 'Demo owner email'
$securePassword = Read-Host 'Demo owner password (input is hidden)' -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
$nodeExitCode = 1

try {
    $env:ALLOW_LOCAL_OWNER_PROVISIONING = 'true'
    $env:DEMO_OWNER_NAME = $name
    $env:DEMO_OWNER_EMAIL = $email
    $env:DEMO_OWNER_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    & node (Join-Path $PSScriptRoot 'provision-demo-owner.js')
    $nodeExitCode = $LASTEXITCODE
}
finally {
    Remove-Item Env:ALLOW_LOCAL_OWNER_PROVISIONING -ErrorAction SilentlyContinue
    Remove-Item Env:DEMO_OWNER_NAME -ErrorAction SilentlyContinue
    Remove-Item Env:DEMO_OWNER_EMAIL -ErrorAction SilentlyContinue
    Remove-Item Env:DEMO_OWNER_PASSWORD -ErrorAction SilentlyContinue
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    $securePassword.Dispose()
}

if ($nodeExitCode -ne 0) {
    throw 'Local demo owner provisioning failed.'
}
