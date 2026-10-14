# One-command remote performance run for Windows PowerShell.
#   powershell -ExecutionPolicy Bypass -File scripts\perf\run-remote.ps1
# Asks for the admin password (typed hidden, never printed or saved), runs the sweep against Render, then builds the report.
param(
  [string]$BaseUrl = "https://sevanest-backend.onrender.com",
  [string]$CustomerMobile = "+919999900002",
  [string]$WorkerMobile = "+919999900001",
  [string]$OtpCode = "123456",
  [string]$AdminEmail = "sevanest@admin.in",
  [int]$Iterations = 15,
  [switch]$Writes
)

$secure = Read-Host "Admin password for $AdminEmail (leave empty to skip admin routes)" -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))

$env:PERF_BASE_URL = $BaseUrl
$env:PERF_CUSTOMER_MOBILE = $CustomerMobile
$env:PERF_WORKER_MOBILE = $WorkerMobile
$env:PERF_OTP_CODE = $OtpCode
$env:PERF_ITERATIONS = "$Iterations"
if ($plain) { $env:PERF_ADMIN_EMAIL = $AdminEmail; $env:PERF_ADMIN_PASSWORD = $plain }
if ($Writes) { $env:PERF_WRITES = "1" }

try {
  node scripts/perf/run-remote.mjs
  if ($LASTEXITCODE -eq 0) { node scripts/perf/report.mjs test/perf/out-remote docs/qa }
} finally {
  Remove-Item Env:PERF_ADMIN_PASSWORD, Env:PERF_OTP_CODE -ErrorAction SilentlyContinue
  $plain = $null
}
