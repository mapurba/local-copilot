# Ping every IP in 10.71.33.0-254 and register responding ones with the central registry.
param(
    [string]$Subnet = "10.71.33",
    [int]$Start = 0,
    [int]$End = 254,
    [string]$RegistryUrl = "http://164.99.91.31:5100/api/res-ip"
)

$ips = $Start..$End | ForEach-Object { "$Subnet.$_" }

# Fire all pings in parallel via .NET; Test-Connection is too slow for 255 hosts on PS 5.1.
$pings = foreach ($ip in $ips) {
    $p = New-Object System.Net.NetworkInformation.Ping
    [pscustomobject]@{ Ip = $ip; Task = $p.SendPingAsync($ip, 1000) }
}
try { [System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]$pings.Task) } catch { }

$alive = $pings | Where-Object {
    $_.Task.Status -eq 'RanToCompletion' -and $_.Task.Result.Status -eq 'Success'
} | Select-Object -ExpandProperty Ip

Write-Host "Reachable IPs: $($alive.Count)"

foreach ($ip in $alive) {
    $body = @{ ip = $ip; status = "used" } | ConvertTo-Json -Compress
    try {
        $resp = Invoke-RestMethod -Method Post -Uri $RegistryUrl -ContentType "application/json" -Body $body -TimeoutSec 10
        Write-Host "$ip registered: $($resp | ConvertTo-Json -Compress)"
    } catch {
        Write-Warning "$ip registration failed: $($_.Exception.Message)"
    }
}
