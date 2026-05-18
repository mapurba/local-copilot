/**
 * Shell script fragments – OS-specific network configuration.
 *
 * Relies on bash variables set by the calling script:
 *   $primary_iface, $LOG
 *
 * Placeholders replaced at runtime by getUnifiedCustomizationScript():
 *   __IP_WITH_CIDR__, __GATEWAY__, __DNS_ALL__, __DNS_YAML__
 */

// ── SLES / SUSE ──────────────────────────────────────────────────────────────
// Supports both NetworkManager (GNOME/Workstation) and Wicked (Server) stacks.
// Old gateway entries are flushed from the kernel before applying the new config
// to guarantee our gateway is the only default route on eth0/primary_iface.
export const SLES_NETWORK_SCRIPT = `
    mkdir -p /etc/cloud/cloud.cfg.d/
    echo "network: {config: disabled}" > /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg

    # Remove ALL stale interface-specific route files from the template so wicked
    # cannot re-inject the old gateway on ifreload
    rm -f /etc/sysconfig/network/ifroute-*

    # Flush every existing default route from the kernel before we apply new config
    ip route flush default 2>/dev/null || true

    if systemctl is-active --quiet NetworkManager; then
        nmcli con mod "$primary_iface" ipv4.method manual \\
            ipv4.addresses __IP_WITH_CIDR__ ipv4.gateway __GATEWAY__ ipv4.dns "__DNS_ALL__"
        nmcli con down "$primary_iface" 2>/dev/null || true
        nmcli con up   "$primary_iface"
        # Remove ALL default routes (there may be more than one), then add exactly ours
        while ip route del default 2>/dev/null; do :; done
        ip route add default via __GATEWAY__ dev "$primary_iface"
        echo "SLES (NetworkManager) configured: __IP_WITH_CIDR__" >> "$LOG"
    else
        rm -f /etc/sysconfig/network/ifcfg-eth* /etc/sysconfig/network/ifcfg-ens*
        cat <<EOF > /etc/sysconfig/network/ifcfg-$primary_iface
BOOTPROTO='static'
STARTMODE='auto'
IPADDR='__IP_WITH_CIDR__'
EOF
        # Write global routes file — bind our default gateway to the primary interface
        # so wicked cannot add a deviceless duplicate (which is what appeared as
        # "default 10.71.x.x  -  eth0" in the routing table)
        printf 'default __GATEWAY__ - %s\\n' "$primary_iface" > /etc/sysconfig/network/routes
        if grep -q "^NETCONFIG_DNS_STATIC_SERVERS=" /etc/sysconfig/network/config; then
            sed -i 's/^NETCONFIG_DNS_STATIC_SERVERS=.*/NETCONFIG_DNS_STATIC_SERVERS="__DNS_ALL__"/' \\
                /etc/sysconfig/network/config
        else
            echo 'NETCONFIG_DNS_STATIC_SERVERS="__DNS_ALL__"' >> /etc/sysconfig/network/config
        fi
        netconfig update -f && wicked ifreload all
        # Give wicked a moment to settle, then purge any leftover default routes
        sleep 1
        while ip route del default 2>/dev/null; do :; done
        ip route add default via __GATEWAY__ dev "$primary_iface"
        echo "SLES (Wicked) configured: __IP_WITH_CIDR__" >> "$LOG"
    fi
    echo "Active default route: $(ip route show default)" >> "$LOG"
`;

// ── Ubuntu / Debian ──────────────────────────────────────────────────────────
// Writes a static netplan config and applies it.
// Old gateway entries are flushed from the kernel and any stale netplan files
// are removed so the template gateway cannot survive as a second default route.
export const UBUNTU_NETWORK_SCRIPT = `
    mkdir -p /etc/cloud/cloud.cfg.d/
    echo "network: {config: disabled}" > /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg

    # Remove all stale netplan files that could carry the template's old gateway
    rm -f /etc/netplan/*.yaml /etc/netplan/*.yml

    # Flush every existing default route from the kernel before applying new config
    ip route flush default 2>/dev/null || true

    cat <<EOF > /etc/netplan/01-netcfg.yaml
network:
  version: 2
  renderer: networkd
  ethernets:
    $primary_iface:
      dhcp4: no
      addresses:
        - __IP_WITH_CIDR__
      routes:
        - to: 0.0.0.0/0
          via: __GATEWAY__
      nameservers:
        addresses:
          - __DNS_YAML__
EOF
    netplan apply
    # Remove ALL default routes left over, then install exactly ours
    while ip route del default 2>/dev/null; do :; done
    ip route add default via __GATEWAY__ dev "$primary_iface"
    echo "Ubuntu network configured: __IP_WITH_CIDR__" >> "$LOG"
    echo "Active default route: $(ip route show default)" >> "$LOG"
`;

// ── RHEL / CentOS / Rocky ────────────────────────────────────────────────────
// Uses NetworkManager (nmcli) which is standard on all RHEL-family distros.
// Stale NM connection files and kernel routes are purged before applying the
// new config so the template gateway cannot survive as a second default route.
export const RHEL_NETWORK_SCRIPT = `
    mkdir -p /etc/cloud/cloud.cfg.d/
    echo "network: {config: disabled}" > /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg

    # Flush every existing default route from the kernel before applying new config
    ip route flush default 2>/dev/null || true

    nmcli con mod "$primary_iface" ipv4.method manual \\
        ipv4.addresses __IP_WITH_CIDR__ ipv4.gateway __GATEWAY__ ipv4.dns "__DNS_ALL__"
    nmcli con down "$primary_iface" 2>/dev/null || true
    nmcli con up "$primary_iface"
    # Remove ALL default routes left over, then install exactly ours
    while ip route del default 2>/dev/null; do :; done
    ip route add default via __GATEWAY__ dev "$primary_iface"
    echo "RHEL/CentOS network configured: __IP_WITH_CIDR__" >> "$LOG"
    echo "Active default route: $(ip route show default)" >> "$LOG"
`;
