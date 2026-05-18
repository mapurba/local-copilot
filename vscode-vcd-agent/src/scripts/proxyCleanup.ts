/**
 * Shell script fragment – removes ALL known proxy settings.
 *
 * Universal — runs on Ubuntu/Debian, SLES/openSUSE, and RHEL/CentOS/Rocky.
 * Every section is guarded by existence checks so missing paths are silently skipped.
 * Relies on $LOG being set in the calling script.
 */
export const PROXY_CLEANUP_SCRIPT = `
    # ── Proxy removal (universal) ─────────────────────────────────────────────
    echo "Removing all proxy settings..." >> "$LOG"

    # 1. Environment variables — current shell session
    unset http_proxy https_proxy ftp_proxy no_proxy
    unset HTTP_PROXY HTTPS_PROXY FTP_PROXY NO_PROXY

    # 2. System-wide profile / environment files
    for _f in /etc/environment /etc/profile /etc/bash.bashrc ~/.bashrc ~/.profile; do
        [ -f "$_f" ] && sed -i '/_proxy/Id' "$_f"
    done

    # 3. profile.d — remove proxy drop-in files, comment out any remaining lines
    if [ -d /etc/profile.d ]; then
        rm -f /etc/profile.d/*proxy*.sh /etc/profile.d/*proxy*.csh
        grep -rl "proxy" /etc/profile.d/ 2>/dev/null | xargs -r sed -i '/proxy/Is/^/#/'
    fi

    # 4. APT — Debian / Ubuntu
    if [ -d /etc/apt ]; then
        rm -f /etc/apt/apt.conf.d/*proxy*
        [ -f /etc/apt/apt.conf ] && sed -i '/Proxy/Id' /etc/apt/apt.conf
    fi

    # 5. zypper — SLES / openSUSE
    if [ -f /etc/sysconfig/proxy ]; then
        sed -i 's/^PROXY_ENABLED=.*/PROXY_ENABLED="no"/' /etc/sysconfig/proxy
        sed -i '/^HTTP_PROXY=/d; /^HTTPS_PROXY=/d; /^FTP_PROXY=/d; /^NO_PROXY=/d' \
            /etc/sysconfig/proxy
        echo "PROXY_ENABLED=\"no\"" >> /etc/sysconfig/proxy 2>/dev/null || true
    fi
    if [ -f /etc/zypp/zypper.conf ]; then
        sed -i '/^proxy=/Id; /^proxyuser=/Id; /^proxypass=/Id' /etc/zypp/zypper.conf
    fi

    # 6. YUM / DNF — RHEL / CentOS / Rocky
    for _f in /etc/yum.conf /etc/dnf/dnf.conf; do
        [ -f "$_f" ] && \
            sed -i '/^proxy=/Id; /^proxy_username=/Id; /^proxy_password=/Id' "$_f"
    done

    # 7. wget
    for _f in /etc/wgetrc ~/.wgetrc; do
        [ -f "$_f" ] && sed -i '/_proxy/Id' "$_f"
    done

    # 8. curl
    [ -f ~/.curlrc ] && sed -i '/proxy/Id' ~/.curlrc

    # 9. Docker — systemd drop-in, daemon.json, and client config.json
    if [ -d /etc/systemd/system/docker.service.d ]; then
        rm -f /etc/systemd/system/docker.service.d/*proxy*
        systemctl list-units --full -all 2>/dev/null | grep -Fq 'docker.service' && {
            systemctl daemon-reload; systemctl restart docker 2>/dev/null || true
        }
    fi
    if [ -f /etc/docker/daemon.json ]; then
        sed -i '/"httpProxy"/Id; /"httpsProxy"/Id; /"noProxy"/Id' /etc/docker/daemon.json
    fi
    [ -f ~/.docker/config.json ] && sed -i '/proxy/Id' ~/.docker/config.json

    # 10. snap
    command -v snap &>/dev/null && snap set system proxy.http="" proxy.https=""

    # 11. git
    if command -v git &>/dev/null; then
        git config --global --unset http.proxy  2>/dev/null || true
        git config --global --unset https.proxy 2>/dev/null || true
    fi

    echo "All proxy settings removed." >> "$LOG"
`;
