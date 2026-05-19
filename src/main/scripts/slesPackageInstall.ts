/**
 * Shell script fragment – Docker Engine + docker-compose installation (SLES).
 *
 * Relies on $LOG being set in the calling script.
 * Supports SLES 15 (all service packs) and SLES 16.
 *
 * Strategy:
 *   1. Try the official SUSE Containers Module via SUSEConnect (registered systems).
 *   2. Fall back to the openSUSE Virtualization:containers repo matching the
 *      detected VERSION_ID (e.g. 15.5, 15.6, 16.0) — works on unregistered VMs.
 *
 * Install is idempotent — skipped when Docker is already present.
 */
export const SLES_PACKAGE_INSTALL_SCRIPT = `
    # ── Prerequisites + Docker (SLES – all versions) ─────────────────────────
    echo "Installing prerequisites (SLES)..." >> "$LOG"
    zypper --non-interactive --gpg-auto-import-keys refresh >> "$LOG" 2>&1 || true
    zypper --non-interactive install -y curl unzip >> "$LOG" 2>&1

    if ! command -v docker &>/dev/null; then
        echo "Installing Docker Engine on SLES..." >> "$LOG"

        # ── Detect SLES full version (e.g. "15.6" or "16.0") ─────────────────
        SLES_FULL="15.6"
        if [ -f /etc/os-release ]; then
            VER_ID=$(grep '^VERSION_ID=' /etc/os-release | cut -d= -f2 | tr -d '"')
            [ -n "$VER_ID" ] && SLES_FULL="$VER_ID"
        fi
        # Normalise: if VERSION_ID has no minor part (e.g. "16"), append ".0"
        echo "$SLES_FULL" | grep -q '\\.' || SLES_FULL="\${SLES_FULL}.0"
        echo "Detected SLES version: $SLES_FULL" >> "$LOG"

        DOCKER_INSTALLED=false

        # ── 1. Official SUSE Containers Module (registered systems) ──────────
        if command -v SUSEConnect &>/dev/null; then
            echo "Trying SUSE Containers Module via SUSEConnect..." >> "$LOG"
            SUSEConnect -p "sle-module-containers/\${SLES_FULL}/x86_64" >> "$LOG" 2>&1 \\
                && zypper --non-interactive --gpg-auto-import-keys refresh >> "$LOG" 2>&1 \\
                && zypper --non-interactive install -y docker docker-compose >> "$LOG" 2>&1 \\
                && DOCKER_INSTALLED=true \\
                || echo "SUSEConnect method failed; trying openSUSE fallback..." >> "$LOG"
        fi

        # ── 2. openSUSE Virtualization:containers repo (unregistered / fallback) ──
        if [ "$DOCKER_INSTALLED" = "false" ]; then
            CONTAINERS_REPO="https://download.opensuse.org/repositories/Virtualization:containers/\${SLES_FULL}/Virtualization:containers.repo"
            echo "Adding containers repo: $CONTAINERS_REPO" >> "$LOG"
            zypper --non-interactive --gpg-auto-import-keys addrepo "$CONTAINERS_REPO" >> "$LOG" 2>&1 \\
                || echo "WARNING: Could not add containers repo for SLES \${SLES_FULL}" >> "$LOG"
            zypper --non-interactive --gpg-auto-import-keys refresh >> "$LOG" 2>&1 || true
            zypper --non-interactive install -y docker docker-compose >> "$LOG" 2>&1
        fi

        # ── Enable and start Docker ───────────────────────────────────────────
        systemctl enable docker >> "$LOG" 2>&1
        systemctl start docker >> "$LOG" 2>&1

        # Ensure docker-compose is accessible as a standalone command
        if ! command -v docker-compose &>/dev/null; then
            ln -sf /usr/bin/docker-compose /usr/local/bin/docker-compose 2>/dev/null || true
        fi

        echo "Docker installed on SLES \${SLES_FULL}." >> "$LOG"
    fi
`;
