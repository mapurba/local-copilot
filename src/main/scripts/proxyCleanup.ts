/**
 * Shell script fragment – removes ALL known proxy settings.
 *
 * Universal — runs on Ubuntu/Debian, SLES/openSUSE, and RHEL/CentOS/Rocky.
 * Every section is guarded by existence checks so missing paths are silently skipped.
 * Relies on $LOG being set in the calling script.
 *
 * Covers: shell env, profile.d, apt-get, zypper/zypp, yum/dnf/microdnf,
 *         wget, curl, Docker (daemon + systemd + client), containerd, npm,
 *         snap, git.
 */
export const PROXY_CLEANUP_SCRIPT = `
    # ── Proxy removal (universal – all OS, all tools) ────────────────────────
    echo "Removing all proxy settings..." >> "$LOG"

    # Disable errexit for the entire cleanup block so a single missing file,
    # read-only path, or unsupported tool never aborts the calling script.
    case $- in *e*) _proxy_had_errexit=1 ;; *) _proxy_had_errexit=0 ;; esac
    set +e

    # ── 1. Shell environment – current session ────────────────────────────────
    unset http_proxy https_proxy ftp_proxy no_proxy all_proxy
    unset HTTP_PROXY HTTPS_PROXY FTP_PROXY NO_PROXY ALL_PROXY

    # ── 2. System-wide environment files ─────────────────────────────────────
    for _f in /etc/environment /etc/profile /etc/bash.bashrc /etc/zshrc \
              ~/.bashrc ~/.profile ~/.zshrc; do
        [ -f "$_f" ] && sed -i '/[Pp][Rr][Oo][Xx][Yy]/d' "$_f" || true
    done
    # systemd environment.d drop-ins
    if [ -d /etc/environment.d ]; then
        grep -rl -i "proxy" /etc/environment.d/ 2>/dev/null \
            | xargs -r sed -i '/[Pp][Rr][Oo][Xx][Yy]/d' || true
    fi

    # ── 3. profile.d – only remove files whose NAME is a proxy config ─────────
    # Never delete or modify system files (e.g. profile.sh) that merely reference
    # /etc/sysconfig/proxy — those are OS init files, not user proxy settings.
    # /etc/sysconfig/proxy itself is already disabled in section 5.
    if [ -d /etc/profile.d ]; then
        rm -f /etc/profile.d/*[Pp][Rr][Oo][Xx][Yy]*.sh /etc/profile.d/*[Pp][Rr][Oo][Xx][Yy]*.csh
    fi

    # ── 4. APT (Debian / Ubuntu) ──────────────────────────────────────────────
    if [ -d /etc/apt/apt.conf.d ]; then
        # Remove files whose name contains "proxy" AND files whose content sets a proxy
        rm -f /etc/apt/apt.conf.d/*[Pp][Rr][Oo][Xx][Yy]* || true
        grep -rl -i "Acquire::.*[Pp]roxy\\|proxy" /etc/apt/apt.conf.d/ 2>/dev/null \
            | xargs -r rm -f || true
    fi
    if [ -f /etc/apt/apt.conf ]; then
        sed -i '/[Pp]roxy/Id; /Acquire::/Id' /etc/apt/apt.conf || true
    fi

    # ── 5. zypper / zypp (SLES / openSUSE) ───────────────────────────────────
    if [ -f /etc/sysconfig/proxy ]; then
        sed -i 's/^PROXY_ENABLED=.*/PROXY_ENABLED="no"/' /etc/sysconfig/proxy
        sed -i '/^HTTP_PROXY=/d; /^HTTPS_PROXY=/d; /^FTP_PROXY=/d; /^NO_PROXY=/d' \
            /etc/sysconfig/proxy
    fi
    # Both zypper.conf (CLI settings) and zypp.conf (libzypp core settings)
    for _f in /etc/zypp/zypper.conf /etc/zypp/zypp.conf; do
        [ -f "$_f" ] && sed -i '/^proxy/Id; /^proxyuser/Id; /^proxypass/Id' "$_f" || true
    done
    # Per-repo proxy overrides in repos.d
    if [ -d /etc/zypp/repos.d ]; then
        grep -rl -i "^proxy" /etc/zypp/repos.d/ 2>/dev/null \
            | xargs -r sed -i '/^proxy/Id' || true
    fi

    # ── 6. YUM / DNF / microdnf (RHEL / CentOS / Rocky / UBI) ───────────────
    for _f in /etc/yum.conf /etc/dnf/dnf.conf /etc/microdnf/microdnf.conf; do
        [ -f "$_f" ] && \
            sed -i '/^proxy=/Id; /^proxy_username=/Id; /^proxy_password=/Id' "$_f" || true
    done
    # Per-repo proxy settings in yum.repos.d
    if [ -d /etc/yum.repos.d ]; then
        grep -rl -i "^proxy" /etc/yum.repos.d/ 2>/dev/null \
            | xargs -r sed -i '/^proxy/Id' || true
    fi

    # ── 7. wget ───────────────────────────────────────────────────────────────
    for _f in /etc/wgetrc ~/.wgetrc; do
        [ -f "$_f" ] && sed -i '/[Pp]roxy/Id; /^use_proxy/Id' "$_f" || true
    done

    # ── 8. curl ───────────────────────────────────────────────────────────────
    for _f in /etc/curlrc ~/.curlrc; do
        [ -f "$_f" ] && sed -i '/proxy/Id; /noproxy/Id' "$_f" || true
    done

    # ── 9. Docker Engine ──────────────────────────────────────────────────────
    # 9a. Systemd service drop-in proxy files (both system-installed and admin paths)
    _DOCKER_CHANGED=false
    for _dir in /etc/systemd/system/docker.service.d \
                /usr/lib/systemd/system/docker.service.d; do
        if [ -d "$_dir" ]; then
            if find "$_dir" -maxdepth 1 -iname '*proxy*' | grep -q .; then
                rm -f "$_dir"/*[Pp][Rr][Oo][Xx][Yy]*
                _DOCKER_CHANGED=true
            fi
            # Also scrub Environment=*PROXY* lines from any override files
            if grep -rli "proxy" "$_dir" 2>/dev/null | grep -q .; then
                grep -rli "proxy" "$_dir" 2>/dev/null \
                    | xargs -r sed -i '/[Ee]nvironment=.*[Pp][Rr][Oo][Xx][Yy]/d' || true
                _DOCKER_CHANGED=true
            fi
        fi
    done
    # 9b. daemon.json – safely remove proxies block and all proxy-related keys
    if [ -f /etc/docker/daemon.json ]; then
        if command -v python3 &>/dev/null; then
            python3 - <<'EOF_PY'
import json, sys
try:
    with open('/etc/docker/daemon.json', 'r') as f:
        cfg = json.load(f)
    for key in ('proxies', 'httpProxy', 'httpsProxy', 'noProxy',
                'http-proxy', 'https-proxy', 'no-proxy'):
        cfg.pop(key, None)
    with open('/etc/docker/daemon.json', 'w') as f:
        json.dump(cfg, f, indent=2)
except Exception as e:
    sys.stderr.write(f"Warning: could not update daemon.json: {e}\\n")
EOF_PY
        else
            sed -i '/"proxies"/Id; /"httpProxy"/Id; /"httpsProxy"/Id; /"noProxy"/Id' \
                /etc/docker/daemon.json
            sed -i '/"http-proxy"/Id; /"https-proxy"/Id; /"no-proxy"/Id' \
                /etc/docker/daemon.json
        fi
        _DOCKER_CHANGED=true
    fi
    # 9c. Docker CLI client config (build-time proxy)
    if [ -f ~/.docker/config.json ]; then
        if command -v python3 &>/dev/null; then
            python3 - <<'EOF_PY'
import json, os, sys
path = os.path.expanduser('~/.docker/config.json')
try:
    with open(path, 'r') as f:
        cfg = json.load(f)
    cfg.pop('proxies', None)
    with open(path, 'w') as f:
        json.dump(cfg, f, indent=2)
except Exception as e:
    sys.stderr.write(f"Warning: could not update config.json: {e}\\n")
EOF_PY
        else
            sed -i '/proxy/Id' ~/.docker/config.json
        fi
    fi
    # 9d. Reload systemd and restart Docker only if something changed
    if [ "$_DOCKER_CHANGED" = "true" ]; then
        systemctl daemon-reload >> "$LOG" 2>&1 || true
        if systemctl is-active --quiet docker 2>/dev/null; then
            systemctl restart docker >> "$LOG" 2>&1 || true
            echo "Docker restarted after proxy removal." >> "$LOG"
        fi
    fi

    # ── 10. containerd ────────────────────────────────────────────────────────
    for _dir in /etc/systemd/system/containerd.service.d \
                /usr/lib/systemd/system/containerd.service.d; do
        if [ -d "$_dir" ]; then
            rm -f "$_dir"/*[Pp][Rr][Oo][Xx][Yy]* || true
            grep -rli "proxy" "$_dir" 2>/dev/null \
                | xargs -r sed -i '/[Ee]nvironment=.*[Pp][Rr][Oo][Xx][Yy]/d' || true
        fi
    done

    # ── 11. npm ───────────────────────────────────────────────────────────────
    if command -v npm &>/dev/null; then
        npm config delete proxy       2>/dev/null || true
        npm config delete https-proxy 2>/dev/null || true
    fi
    for _f in /etc/npmrc ~/.npmrc; do
        [ -f "$_f" ] && sed -i '/proxy/Id' "$_f" || true
    done

    # ── 12. snap ──────────────────────────────────────────────────────────────
    if command -v snap &>/dev/null; then
        snap set system proxy.http=""  2>/dev/null || true
        snap set system proxy.https="" 2>/dev/null || true
    fi

    # ── 13. git ───────────────────────────────────────────────────────────────
    if command -v git &>/dev/null; then
        git config --global --unset http.proxy  2>/dev/null || true
        git config --global --unset https.proxy 2>/dev/null || true
    fi

    # Restore errexit if it was active before the cleanup block.
    [ "$_proxy_had_errexit" = "1" ] && set -e

    echo "All proxy settings removed." >> "$LOG"
`;
