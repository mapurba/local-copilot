/**
 * Shell script fragment – Docker Engine installation (Ubuntu/Debian only).
 *
 * Relies on $LOG being set in the calling script.
 * Install is idempotent — skipped when Docker is already present.
 */
export const PACKAGE_INSTALL_SCRIPT = `
    # ── Prerequisites + Docker (Ubuntu/Debian only) ───────────────────────────
    export DEBIAN_FRONTEND=noninteractive
    echo "Installing prerequisites..." >> "$LOG"
    apt-get update -y >> "$LOG" 2>&1
    apt-get install -y ca-certificates curl gnupg lsb-release apt-transport-https \
        software-properties-common unzip >> "$LOG" 2>&1

    if ! command -v docker &>/dev/null; then
        echo "Installing Docker Engine..." >> "$LOG"
        install -m 0755 -d /etc/apt/keyrings
        curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
            | gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
        chmod a+r /etc/apt/keyrings/docker.gpg
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \\
https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
            | tee /etc/apt/sources.list.d/docker.list >/dev/null
        apt-get update -y >> "$LOG" 2>&1
        apt-get install -y docker-ce docker-ce-cli containerd.io \
            docker-buildx-plugin docker-compose-plugin >> "$LOG" 2>&1
        ln -sf /usr/libexec/docker/cli-plugins/docker-compose /usr/local/bin/docker-compose
        echo "Docker installed." >> "$LOG"
    fi
`;
