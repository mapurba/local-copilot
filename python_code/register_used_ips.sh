#!/bin/bash
# Ping every IP in 10.71.33.0-254 and register responding ones with the central registry.
set -u

SUBNET="10.71.33"
START=0
END=254
REGISTRY_URL="${REGISTRY_URL:-http://164.99.91.31:5100/api/res-ip}"
LOG="${LOG:-/root/vcdcustlog}"
MAX_PARALLEL=50

touch "$LOG" 2>/dev/null || LOG="./ip_scan.log"

check_and_register() {
    local ip="$1"
    if ping -c 1 -W 1 "$ip" >/dev/null 2>&1; then
        echo "$ip is reachable. Registering IP with central registry..." >>"$LOG"
        curl -s -m 10 -X POST "$REGISTRY_URL" \
            -H "Content-Type: application/json" \
            -d "{\"ip\": \"$ip\", \"status\": \"used\"}" >>"$LOG" 2>&1 \
            || echo "IP registration request for $ip failed (registry may be unavailable)" >>"$LOG"
        echo "$ip registered"
    fi
}

echo "Starting ping scan of $SUBNET.$START-$END" >>"$LOG"

for i in $(seq "$START" "$END"); do
    check_and_register "$SUBNET.$i" &
    while [ "$(jobs -rp | wc -l)" -ge "$MAX_PARALLEL" ]; do
        sleep 0.1
    done
done

wait
echo "Ping scan completed" >>"$LOG"
