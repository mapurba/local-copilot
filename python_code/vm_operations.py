import requests
import urllib3
import json
import logging
import time

logger = logging.getLogger(__name__)

# Inside your node:
logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler("debug_log.txt", mode='a'), # 'a' appends, 'w' overwrites
        logging.StreamHandler() # This keeps logs appearing in the console too
    ]
)
# Disable SSL warnings for internal labs
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

class VMOperations:
    """
    Handles VM-related operations in VMware Cloud Director.
    """
    
    def __init__(self, vcd_host, token, api_version="38.0"):
        """
        Initialize VM operations handler.
        
        Args:
            vcd_host: VCD server hostname
            token: Authentication token
            api_version: VCD API version (default: "38.0")
        """
        self.vcd_host = vcd_host
        self.token = token
        self.api_version = api_version
    
    def list_vms(self, page_size=100, save_to_file=None):
        """
        Uses the Query Service to list VMs.
        This is the most efficient way to get a flat list of all VMs in the tenant.
        
        Args:
            page_size: Number of VMs to fetch per page (default: 100)
            save_to_file: Optional filename to save results (e.g., 'vms.json')
        
        Returns:
            list: List of VM records
        """
        print("\nFetching VM List...")
        
        # The Query API (api/query) is NOT deprecated and is the standard for listing.
        url = f"https://{self.vcd_host}/api/query"
        
        headers = {
            "Accept": f"application/*+json;version={self.api_version}",
            "Authorization": f"Bearer {self.token}"
        }
        
        params = {
            "type": "vm",               # Filter for Virtual Machines
            "format": "records",        # Simplified JSON format
            "pageSize": page_size
        }

        try:
            response = requests.get(url, headers=headers, params=params, verify=False)
            response.raise_for_status()
            
            data = response.json()
            
            # 'record' is the list of items in the response
            vms = data.get('record', [])
            print(f"   -> Found {len(vms)} VMs")
            
            # Save VM list to JSON file if requested
            if save_to_file:
                with open(save_to_file, 'w') as f:
                    json.dump(vms, f, indent=2)
                print(f"   -> Saved to {save_to_file}\n")
            
            return vms
            
        except Exception as e:
            print(f"   -> Error listing VMs: {e}")
            raise
    
    def get_vm_details(self, vm_id):
        """
        Get detailed information about a specific VM.
        
        Args:
            vm_id: VM identifier
        
        Returns:
            dict: VM details
        """
        url = f"https://{self.vcd_host}/api/vApp/vm-{vm_id}"
        
        headers = {
            "Accept": f"application/*+json;version={self.api_version}",
            "Authorization": f"Bearer {self.token}"
        }
        
        try:
            response = requests.get(url, headers=headers, verify=False)
            response.raise_for_status()
            return response.json()
        except Exception as e:
            print(f"Error getting VM details: {e}")
            raise
    
    def power_on_vm(self, vm_href: str) -> dict:
        """Power on a VM using its href."""
        url = f"{vm_href}/power/action/powerOn"
        headers = {
            "Accept": f"application/*+json;version={self.api_version}",
            "Authorization": f"Bearer {self.token}",
            "Content-Length": "0",
        }
        response = requests.post(url, headers=headers, verify=False, timeout=30)
        response.raise_for_status()
        return {"status": "success", "action": "powerOn", "vm_href": vm_href}

    def power_off_vm(self, vm_href: str) -> dict:
        """Power off a VM using its href."""
        url = f"{vm_href}/power/action/powerOff"
        headers = {
            "Accept": f"application/*+json;version={self.api_version}",
            "Authorization": f"Bearer {self.token}",
            "Content-Length": "0",
        }
        response = requests.post(url, headers=headers, verify=False, timeout=30)
        response.raise_for_status()
        return {"status": "success", "action": "powerOff", "vm_href": vm_href}

    def _validate_resource_ids(self, vdc_id: str, storage_profile_id: str, compute_policy_id: str,
                               org_name: str = "", org_uuid: str = "") -> dict:
        """
        Validate storage profile and compute policy IDs against live VCD API.
        Returns {"valid": True} or {"valid": False, "errors": [...], "available": {...}}.
        """
        errors = []
        available = {}
        headers_json = {
            "Accept": f"application/*+json;version={self.api_version}",
            "Authorization": f"Bearer {self.token}",
        }
        if org_name:
            headers_json["x-vmware-vcloud-auth-context"] = org_name
        if org_uuid:
            headers_json["x-vmware-vcloud-tenant-context"] = org_uuid

        # ── Validate Storage Profile ──────────────────────────────────────────
        sp_url = f"https://{self.vcd_host}/api/vdcStorageProfile/{storage_profile_id}"
        try:
            r = requests.get(sp_url, headers=headers_json, verify=False, timeout=15)
            if r.status_code == 403:
                errors.append(f"Storage profile {storage_profile_id!r} exists but access is forbidden.")
            elif r.status_code != 200:
                errors.append(f"Storage profile {storage_profile_id!r} not found (HTTP {r.status_code}).")
                # Fetch available storage profiles for this VDC
                q = requests.get(
                    f"https://{self.vcd_host}/api/query",
                    headers=headers_json,
                    params={"type": "vdcStorageProfile", "format": "records",
                            "filter": f"vdc==https://{self.vcd_host}/api/vdc/{vdc_id}"},
                    verify=False, timeout=15,
                )
                if q.ok:
                    available["storage_profiles"] = [
                        {"name": s.get("name"), "id": s.get("href", "").split("/vdcStorageProfile/")[-1]}
                        for s in q.json().get("record", [])
                    ]
        except Exception as e:
            errors.append(f"Storage profile validation error: {e}")

        # ── Validate Compute Policy ───────────────────────────────────────────
        cp_url = f"https://{self.vcd_host}/cloudapi/1.0.0/vdcComputePolicies/{compute_policy_id}"
        headers_cloudapi = {
            "Accept": f"application/json;version={self.api_version}",
            "Authorization": f"Bearer {self.token}",
        }
        try:
            r = requests.get(cp_url, headers=headers_cloudapi, verify=False, timeout=15)
            if r.status_code == 403:
                errors.append(f"Compute policy {compute_policy_id!r} exists but access is forbidden.")
            elif r.status_code != 200:
                errors.append(f"Compute policy {compute_policy_id!r} not found (HTTP {r.status_code}).")
                # Fetch available compute policies for this VDC
                q = requests.get(
                    f"https://{self.vcd_host}/cloudapi/1.0.0/vdcComputePolicies",
                    headers=headers_cloudapi,
                    params={"filter": f"pvdcComputePolicy.id==urn:vcloud:vdc:{vdc_id}", "pageSize": 50},
                    verify=False, timeout=15,
                )
                if q.ok:
                    available["compute_policies"] = [
                        {"name": p.get("name"), "id": p.get("id", "").split(":")[-1]}
                        for p in q.json().get("values", [])
                    ]
        except Exception as e:
            errors.append(f"Compute policy validation error: {e}")

        if errors:
            return {"valid": False, "errors": errors, "available": available}
        return {"valid": True}

    # SLES/SUSE template name patterns (case-insensitive substring match)
    _SLES_PATTERNS = ("sles_15", "sles15", "sles", "suse", "sp5", "sp6", "sp7")

    def _resolve_template_vm_href(self, vapptemplate_uuid: str, org_name: str = "", org_uuid: str = "") -> str:
        """
        Given a vApp template UUID (the 'vappTemplate-{uuid}' ID), fetch the template
        and return the href of its first child VM (the 'vm-{child_uuid}' object that
        InstantiateVmTemplateParams actually needs as its Source).

        Returns the full child VM href on success, or falls back to constructing
        vm-{vapptemplate_uuid} (legacy behaviour) if the lookup fails.
        """
        url = f"https://{self.vcd_host}/api/vAppTemplate/vappTemplate-{vapptemplate_uuid}"
        headers = {
            "Accept": f"application/*+xml;version={self.api_version}",
            "Authorization": f"Bearer {self.token}",
        }
        if org_name:
            headers["x-vmware-vcloud-auth-context"] = org_name
        if org_uuid:
            headers["x-vmware-vcloud-tenant-context"] = org_uuid

        try:
            resp = requests.get(url, headers=headers, verify=False, timeout=15)
            resp.raise_for_status()
            # The XML response contains <Children><Vm href="...vm-<uuid>..." .../></Children>
            import xml.etree.ElementTree as ET
            root = ET.fromstring(resp.text)
            ns = {"v": "http://www.vmware.com/vcloud/v1.5"}
            # Look for Vm elements either directly or inside Children
            for tag in ("v:Children/v:Vm", "v:Vm"):
                vm_el = root.find(tag, ns)
                if vm_el is not None:
                    child_href = vm_el.get("href", "")
                    if child_href:
                        print(f"   -> Resolved child VM href: {child_href}")
                        return child_href
            print(f"   -> WARNING: no child Vm element found in vAppTemplate {vapptemplate_uuid}, using fallback href")
        except Exception as e:
            print(f"   -> WARNING: could not resolve child VM href for vappTemplate-{vapptemplate_uuid}: {e}")

        # Fallback: construct legacy href (likely wrong UUID but preserves old behaviour)
        return f"https://{self.vcd_host}/api/vAppTemplate/vm-{vapptemplate_uuid}"

    @staticmethod
    def _is_sles_template(template_name: str) -> bool:
        """Return True if the template name indicates a SLES 15 OS."""
        if not template_name:
            return False
        name_lower = template_name.lower()
        matched = any(name_lower.startswith(p) or p in name_lower for p in VMOperations._SLES_PATTERNS)
        return matched

    def create_vm_from_template(self, vdc_id, template_vm_id, vm_name,
                                # Default values from working XML payload
                                template_name="",
                                org_name="",
                                org_uuid="",
                                network_name="BAN2_Vlan90_lr0",
                                ip_address="10.71.33.180",
                                gateway="10.71.39.254",
                                dns_servers=None,
                                power_on=True,
                                ip_allocation_mode="DHCP",  # DHCP or POOL or MANUAL
                                network_adapter_type="VMXNET3",
                                storage_profile_id="90895948-aca6-468f-9b3f-edc538b28300",
                                compute_policy_id="99d7f24e-f634-40b4-bebe-e1e06d27c26f",
                                setup_ilm=False,
                                ilm_version="latest",
                                custom_script=None):
        """
        Create a new VM from a VM template using the InstantiateVmTemplateParams endpoint.
        This matches the XML payload structure that works with VCD.
        
        Args:
            vdc_id: VDC (Virtual Data Center) ID where VM will be created
            template_vm_id: VM Template ID (e.g., "f0d3d261-f5ec-4ed0-a713-1291beae6683")
            vm_name: Name for the new VM
            network_name: Network name to connect to (default: "BAN2_Vlan90_lr0")
            ip_address: Static IP address for MANUAL mode (default: "10.71.33.180")
            gateway: Gateway IP address (default: "10.71.39.254")
            dns_servers: List of DNS servers (default: ["15.122.222.53"])
            power_on: Power on VM after creation (default: True)
            ip_allocation_mode: IP allocation mode - DHCP, POOL, or MANUAL (default: "DHCP")
            network_adapter_type: Network adapter type (default: "VMXNET3")
            storage_profile_id: Storage profile ID (default from XML)
            compute_policy_id: VM sizing policy ID (default from XML)
            custom_script: Custom bash script for post-customization (optional)
        
        Returns:
            dict: Response containing the created VM details
        """
        if dns_servers is None:
            dns_servers = ["15.122.222.53"]

        # Use unified customization script that detects OS at runtime
        if custom_script is None:
            print(f"   -> Using unified auto-detecting customization script (will detect OS at runtime)")
            custom_script = self._get_unified_customization_script(ip_address, gateway, dns_servers,setup_ilm=setup_ilm, ilm_version=ilm_version)

        # VCD requires ComputerName: alphanumeric + hyphens + dots, not all-digits.
        # Replace underscores/spaces with hyphens, drop everything else invalid.
        import re as _re
        computer_name = _re.sub(r'[^a-zA-Z0-9\-.]', '-', vm_name).strip('-')
        if not computer_name or _re.fullmatch(r'\d+', computer_name):
            computer_name = f"vm-{computer_name or 'host'}"
        
        print(f"\nCreating VM '{vm_name}' from template...")
        print(f"   -> Template VM ID: {template_vm_id}")
        print(f"   -> Network: {network_name}")
        print(f"   -> IP Allocation: {ip_allocation_mode}")
        if ip_allocation_mode == "MANUAL":
            print(f"   -> IP Address: {ip_address}")
            print(f"   -> Gateway: {gateway}")
        print(f"   -> Power On: {power_on}")
        
        # Construct the endpoint URL for VM template instantiation
        url = f"https://{self.vcd_host}/api/vdc/{vdc_id}/action/instantiateVmFromTemplate"

        headers = {
            "Accept": f"application/*+xml;version={self.api_version}",
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/*+xml;charset=UTF-8",
        }
        # Multi-tenant context headers — required when the token org differs from the target VDC org
        if org_name:
            headers["x-vmware-vcloud-auth-context"] = org_name
        if org_uuid:
            headers["x-vmware-vcloud-tenant-context"] = org_uuid

        # Resolve the actual child VM href from the vApp template.
        # list_templates returns the vappTemplate UUID; the InstantiateVmTemplateParams
        # Source needs the child vm-{child_uuid} href which is a DIFFERENT UUID.
        template_href = self._resolve_template_vm_href(template_vm_id, org_name=org_name, org_uuid=org_uuid)
        # Extract child VM UUID from the resolved href (strip scheme+host+path prefix, then "vm-")
        child_vm_uuid = template_href.rstrip("/").split("/")[-1]
        if child_vm_uuid.startswith("vm-"):
            child_vm_uuid = child_vm_uuid[3:]
        storage_profile_href = f"https://{self.vcd_host}/api/vdcStorageProfile/{storage_profile_id}"
        
        # Build IP address section based on allocation mode
        ip_section = ""
        if ip_allocation_mode == "MANUAL":
            ip_section = f"<IpAddress>{ip_address}</IpAddress>"
        else:
            ip_section = "<IpAddress/>"
        
        xml_payload = f'''<?xml version="1.0" encoding="UTF-8"?>
<InstantiateVmTemplateParams
    xmlns="http://www.vmware.com/vcloud/v1.5"
    xmlns:ovf="http://schemas.dmtf.org/ovf/envelope/1"
    name="{vm_name}"
    powerOn="{str(power_on).lower()}">
    <Description>VM created from template</Description>
    <SourcedVmTemplateItem>
        <Source
            href="{template_href}"
            id="urn:vcloud:vm:{child_vm_uuid}"
            type="application/vnd.vmware.vcloud.vm+xml"/>
        <VmTemplateInstantiationParams>
            <NetworkConnectionSection>
                <ovf:Info/>
                <PrimaryNetworkConnectionIndex>0</PrimaryNetworkConnectionIndex>
                <NetworkConnection network="{network_name}">
                    <NetworkConnectionIndex>0</NetworkConnectionIndex>
                    {ip_section}
                    <IpType>IPV4</IpType>
                    <IsConnected>true</IsConnected>
                    <IpAddressAllocationMode>{ip_allocation_mode}</IpAddressAllocationMode>
                    <NetworkAdapterType>{network_adapter_type}</NetworkAdapterType>
                </NetworkConnection>
            </NetworkConnectionSection>
            <GuestCustomizationSection>
                <ovf:Info>Specifies Guest OS Customization Settings</ovf:Info>
                <Enabled>true</Enabled>
                <ChangeSid>false</ChangeSid>
                <JoinDomainEnabled>false</JoinDomainEnabled>
                <UseOrgSettings>false</UseOrgSettings>
                <AdminPasswordEnabled>false</AdminPasswordEnabled>
                <AdminPasswordAuto>false</AdminPasswordAuto>
                <AdminAutoLogonEnabled>false</AdminAutoLogonEnabled>
                <AdminAutoLogonCount>0</AdminAutoLogonCount>
                <ResetPasswordRequired>false</ResetPasswordRequired>
                <CustomizationScript><![CDATA[{custom_script}]]></CustomizationScript>
                <ComputerName>{computer_name}</ComputerName>
            </GuestCustomizationSection>
        </VmTemplateInstantiationParams>
        <StorageProfile
            href="{storage_profile_href}"
            type="application/vnd.vmware.vcloud.vdcStorageProfile+xml"/>
    </SourcedVmTemplateItem>
    <AllEULAsAccepted>true</AllEULAsAccepted>
    <ComputePolicy>
        <VmSizingPolicy
            href="urn:vcloud:vdcComputePolicy:{compute_policy_id}"
            id="urn:vcloud:vdcComputePolicy:{compute_policy_id}"/>
    </ComputePolicy>
</InstantiateVmTemplateParams>'''
        
        try:
            response = requests.post(url, headers=headers, data=xml_payload, verify=False)
            response.raise_for_status()
            
            print(f"   -> VM creation initiated successfully!")
            print(f"   -> Status Code: {response.status_code}")
            
            # Parse the response (it will be XML)
            return {
                "status": "success",
                "status_code": response.status_code,
                "response_text": response.text[:500]  # First 500 chars of response
            }
            
        except requests.exceptions.HTTPError as e:
            print(f"   -> Error creating VM: {e}")
            if 'response' in locals():
                print(f"   -> Response: {response.text}") # type: ignore
            raise
        except Exception as e:
            print(f"   -> Error creating VM: {e}")
            raise
    
    def _get_unified_customization_script(self, ip_address, gateway, dns_servers, setup_ilm=False, ilm_version="latest"):
        """
        Generate a unified customization script that detects the OS at runtime
        and applies the appropriate network configuration automatically.
        """
        if "/" not in ip_address:
            ip_with_cidr = f"{ip_address}/21"
        else:
            ip_with_cidr = ip_address

        dns_primary = dns_servers[0] if dns_servers else "15.122.222.53"
        dns_all = " ".join(dns_servers) if dns_servers else dns_primary
        dns_yaml = "\n          - ".join(dns_servers)

        # Map ILM version to appropriate values
        ilm_enabled = "true" if setup_ilm else "false"
        
        # Map version string to actual version numbers and URLs
        if ilm_version == "latest":
            ilm_version_mapped = "1.3.0"
        else:
            ilm_version_mapped = ilm_version
        
        # Define version-specific details
        version_mapping = {
            "1.3.0": {
                "url": "https://blr-idm-jenkins.labs.blr.novell.com:8443/job/ILM/job/ilm-containers-1.3.0/lastSuccessfulBuild/artifact/com/opentext/ilm/compose/1.3.0.0000/compose-1.3.0.0000.zip",
                "full_version": "1.3.0.0000"
            },
            "1.2.0": {
                "url": "https://blr-idm-jenkins.labs.blr.novell.com:8443/job/ILM/job/ilm-containers-1.2.0/lastSuccessfulBuild/artifact/com/opentext/ilm/compose/1.2.0.0000/compose-1.2.0.0000.zip",
                "full_version": "1.2.0.0000"
            },
            "1.0.0": {
                "url": "https://blr-idm-jenkins.labs.blr.novell.com:8443/job/ILM/job/ilm-containers/lastSuccessfulBuild/artifact/com/opentext/ilm/compose/1.0.0.0000/compose-1.0.0.0000.zip",
                "full_version": "1.0.0.0000"
            }
        }
        
        ilm_url = version_mapping.get(ilm_version_mapped, version_mapping["1.3.0"])["url"]
        ilm_full_version = version_mapping.get(ilm_version_mapped, version_mapping["1.3.0"])["full_version"]

        script = f'''#!/bin/bash
#scriptversion:20250302-unified-fixed-final
#Auto-detecting customization script for VCD guest OS
set -u

LOG="/root/vcdcustlog"
touch "$LOG"

echo "Script Start" >> "$LOG"
echo "Customization status is: ${{1:-}}" >> "$LOG"
echo "Running PostCust check" >> "$LOG"

# Fix: Use ${{1:-}} to handle empty variable safely
if [ "x${{1:-}}" != "xpostcustomization" ]; then
    echo "VCD Post IF statement was not accepted" >> "$LOG"
    exit 0
fi

echo "VCD Post IF statement accepted" >> "$LOG"

# ============================================================================
# ILM SETUP CONFIGURATION VARIABLES
# ============================================================================
SETUP_ILM="{ilm_enabled}"
ILM_VERSION="{ilm_version_mapped}"
ILM_FULL_VERSION="{ilm_full_version}"
ILM_COMPOSE_URL="{ilm_url}"
echo "ILM Setup Enabled: $SETUP_ILM, Version: $ILM_VERSION" >> "$LOG"

# ============================================================================
# OS DETECTION
# ============================================================================
echo "Detecting operating system..." >> "$LOG"

OS_TYPE="unknown"

if [ -f /etc/os-release ]; then
    . /etc/os-release
    case "$ID" in
        sled|sles|suse|opensuse*)
            OS_TYPE="sles"
            echo "Detected OS: SLES/SUSE ($PRETTY_NAME)" >> "$LOG"
            ;;
        ubuntu|debian)
            OS_TYPE="ubuntu"
            echo "Detected OS: Ubuntu/Debian ($PRETTY_NAME)" >> "$LOG"
            ;;
        rhel|centos|rocky|almalinux)
            OS_TYPE="rhel"
            echo "Detected OS: RHEL/CentOS family ($PRETTY_NAME)" >> "$LOG"
            ;;
        *)
            echo "Detected OS: $PRETTY_NAME (ID=$ID)" >> "$LOG"
            ;;
    esac
fi

echo "OS_TYPE=$OS_TYPE" >> "$LOG"

# ============================================================================
# INTERFACE DETECTION (Universal)
# ============================================================================
primary_iface=$(ip -o link | awk '$2 != "lo:" && $2 !~ /^lo@/ {{print $2; exit}}' | sed 's/://' | sed 's/@.*//')
if [ -z "$primary_iface" ]; then
    primary_iface=eth0
fi
echo "Primary interface: $primary_iface" >> "$LOG"

# ============================================================================
# SLES/SUSE CONFIGURATION
# ============================================================================
if [ "$OS_TYPE" = "sles" ]; then
    echo "Applying SLES network configuration..." >> "$LOG"

    mkdir -p /etc/cloud/cloud.cfg.d/
    echo "network: {{config: disabled}}" > /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg

    if systemctl is-active --quiet NetworkManager; then
        echo "NetworkManager detected (GNOME environment). Using nmcli..." >> "$LOG"
        nmcli con mod "$primary_iface" ipv4.method manual ipv4.addresses {ip_with_cidr} ipv4.gateway {gateway} ipv4.dns "{dns_all}"
        nmcli con up "$primary_iface"
        echo "SLES (NetworkManager) configured successfully: {ip_with_cidr}" >> "$LOG"
    else
        echo "Wicked detected (Server environment). Using sysconfig..." >> "$LOG"
        rm -f /etc/sysconfig/network/ifcfg-eth*
        rm -f /etc/sysconfig/network/ifcfg-ens*

        cat <<EOF > /etc/sysconfig/network/ifcfg-$primary_iface
BOOTPROTO='static'
STARTMODE='auto'
IPADDR='{ip_with_cidr}'
EOF
        echo "default {gateway} - -" > /etc/sysconfig/network/routes
        
        if grep -q "^NETCONFIG_DNS_STATIC_SERVERS=" /etc/sysconfig/network/config; then
            sed -i 's/^NETCONFIG_DNS_STATIC_SERVERS=.*/NETCONFIG_DNS_STATIC_SERVERS="{dns_all}"/' /etc/sysconfig/network/config
        else
            echo "NETCONFIG_DNS_STATIC_SERVERS=\"{dns_all}\"" >> /etc/sysconfig/network/config
        fi
        netconfig update -f
        wicked ifreload all
        echo "SLES (Wicked) configured successfully: {ip_with_cidr}" >> "$LOG"
    fi

# ============================================================================
# UBUNTU/DEBIAN CONFIGURATION (netplan)
# ============================================================================
elif [ "$OS_TYPE" = "ubuntu" ]; then
    echo "Applying Ubuntu/Debian network configuration..." >> "$LOG"

    export DEBIAN_FRONTEND=noninteractive

    mkdir -p /etc/cloud/cloud.cfg.d/
    echo "network: {{config: disabled}}" > /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg

    cat <<EOF > /etc/netplan/01-netcfg.yaml
network:
  version: 2
  renderer: networkd
  ethernets:
    $primary_iface:
      dhcp4: no
      addresses:
        - {ip_with_cidr}
      routes:
        - to: 0.0.0.0/0
          via: {gateway}
      nameservers:
        addresses:
          - {dns_yaml}
EOF

    netplan apply
    echo "Ubuntu/Debian network configuration applied successfully: {ip_with_cidr}" >> "$LOG"
    
    echo "Starting bulletproof installation process..." >> "$LOG"
    echo "Starting deep clean of all proxy settings..." >> "$LOG"

    # 1. Clear Environment Variables (Current Session)
    unset http_proxy https_proxy ftp_proxy no_proxy
    unset HTTP_PROXY HTTPS_PROXY FTP_PROXY NO_PROXY

    # 2. Clear System-Wide Environment Files
    [ -f /etc/environment ] && sed -i '/_proxy/I d' /etc/environment
    [ -f /etc/profile ] && sed -i '/_proxy/I d' /etc/profile
    [ -f /etc/bash.bashrc ] && sed -i '/_proxy/I d' /etc/bash.bashrc
    [ -f ~/.bashrc ] && sed -i '/_proxy/I d' ~/.bashrc
    [ -f ~/.profile ] && sed -i '/_proxy/I d' ~/.profile

    # 2.5 Clear Profile.d
    if [ -d /etc/profile.d ]; then
        echo "Cleaning /etc/profile.d/..." >> "$LOG"
        rm -f /etc/profile.d/*proxy*.sh
        rm -f /etc/profile.d/*proxy*.csh
        # Aggressive cleanup: Comment out proxy lines in ANY file
        grep -l "proxy" /etc/profile.d/* 2>/dev/null | xargs -r sed -i '/proxy/I s/^/#/'
    fi

    # 3. Clear APT (Package Manager)
    rm -f /etc/apt/apt.conf.d/*proxy*
    [ -f /etc/apt/apt.conf ] && sed -i '/Proxy/I d' /etc/apt/apt.conf

    # 4. Clear WGET (Crucial Fix)
    [ -f /etc/wgetrc ] && sed -i '/_proxy/I d' /etc/wgetrc
    [ -f ~/.wgetrc ] && sed -i '/_proxy/I d' ~/.wgetrc

    # 5. Clear CURL/Docker/Snap/Git
    [ -f ~/.curlrc ] && sed -i '/proxy/I d' ~/.curlrc
    if [ -d /etc/systemd/system/docker.service.d ]; then
        rm -f /etc/systemd/system/docker.service.d/*proxy*
        if systemctl list-units --full -all | grep -Fq 'docker.service'; then
            systemctl daemon-reload
            systemctl restart docker
        fi
    fi
    [ -f ~/.docker/config.json ] && sed -i '/proxy/I d' ~/.docker/config.json
    
    if command -v snap &> /dev/null; then
        snap set system proxy.http=""
        snap set system proxy.https=""
    fi
    if command -v git &> /dev/null; then
        git config --global --unset http.proxy
        git config --global --unset https.proxy
    fi

    echo "All known proxy settings have been removed." >> "$LOG"
    
    # 1. Update system
    echo "Updating package lists and installing prerequisites..." >> "$LOG"
    apt-get update -y >> "$LOG" 2>&1
    apt-get install -y ca-certificates curl gnupg lsb-release apt-transport-https software-properties-common unzip >> "$LOG" 2>&1

    # 2. Install OpenJDK 11
    if ! command -v java &> /dev/null; then
        echo "Installing OpenJDK 11..." >> "$LOG"
        apt-get install -y openjdk-11-jdk >> "$LOG" 2>&1
        echo "Java 11 installed successfully." >> "$LOG"
    else
        echo "Java is already installed. Skipping..." >> "$LOG"
    fi

    # 3. Install Docker
    if ! command -v docker &> /dev/null; then
        echo "Installing Docker Engine..." >> "$LOG"
        install -m 0755 -d /etc/apt/keyrings
        curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
        chmod a+r /etc/apt/keyrings/docker.gpg

        echo \
        "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
        $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null

        apt-get update -y >> "$LOG" 2>&1
        apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >> "$LOG" 2>&1

        ln -sf /usr/libexec/docker/cli-plugins/docker-compose /usr/local/bin/docker-compose
        echo "Docker installed successfully." >> "$LOG"
    else
        echo "Docker is already installed. Skipping..." >> "$LOG"
    fi

    echo "=====================================================================" >> "$LOG"
    echo "Installation Complete!" >> "$LOG"

    # ============================================================================
    # ILM SETUP (CONDITIONAL)
    # ============================================================================
    if [ "$SETUP_ILM" = "true" ]; then
        echo "Starting ILM setup (Version: $ILM_VERSION)..." >> "$LOG"
        
        echo "Setting hostname to 'lab'..." >> "$LOG"
        hostnamectl set-hostname lab
        
        echo "Updating /etc/hosts..." >> "$LOG"
        if ! grep -q "127.0.0.1 lab" /etc/hosts; then
            echo "127.0.0.1 lab" >> /etc/hosts
            echo "'lab' entry added to /etc/hosts." >> "$LOG"
        else
            echo "'lab' is already set in /etc/hosts." >> "$LOG"
        fi
        
        DOWNLOAD_DIR="/root/Documents"
        echo "Downloading ILM compose zip file from $ILM_COMPOSE_URL..." >> "$LOG"
        mkdir -p $DOWNLOAD_DIR
        
        # Explicitly unset proxy for this command block
        unset http_proxy https_proxy
        
        if wget --timeout=20 --tries=3 --no-proxy --no-check-certificate -O "$DOWNLOAD_DIR/compose.zip" "$ILM_COMPOSE_URL" >> "$LOG" 2>&1; then
            echo "ILM compose zip file downloaded successfully." >> "$LOG"
            
            echo "Unzipping ILM compose zip file..." >> "$LOG"
            unzip -o "$DOWNLOAD_DIR/compose.zip" -d "$DOWNLOAD_DIR" >> "$LOG" 2>&1
            
            WORK_DIR="$DOWNLOAD_DIR/ilm"
            if [ ! -d "$WORK_DIR" ]; then
                WORK_DIR="$DOWNLOAD_DIR/compose-$ILM_FULL_VERSION"
            fi
            
            if [ -d "$WORK_DIR" ]; then
                cd "$WORK_DIR"
                
                # Modify .env file
                ENV_FILE=".env"
                if [ -f "$ENV_FILE" ]; then
                    echo "Modifying .env file..." >> "$LOG"
                    sed -i "s|TENANT_OSP_REDIRECT_URL=.*|TENANT_OSP_REDIRECT_URL=http://lab:9888/ilm/|g" $ENV_FILE
                    sed -i "s|CALLBACK_SERVER=.*|CALLBACK_SERVER=http://lab:9990|g" $ENV_FILE
                    sed -i "s|SECRETS_URL=.*|SECRETS_URL=http://lab:4566|g" $ENV_FILE
                    echo ".env file modified successfully." >> "$LOG"
                else
                    echo "ERROR: .env file not found in $WORK_DIR" >> "$LOG"
                fi
                                
                # --- IMPROVED DOCKER COMPOSE HANDLING ---
                echo "Step 1/3: Pulling Docker images (with retries)..." >> "$LOG"
                
                # Use seq for loop to avoid syntax ambiguity
                for i in $(seq 1 3); do
                    if timeout 600 docker compose pull --ignore-pull-failures >> "$LOG" 2>&1; then
                        echo "Images pulled successfully." >> "$LOG"
                        break
                    else
                        echo "WARNING: Docker pull attempt $i failed or timed out. Retrying in 10s..." >> "$LOG"
                        sleep 10
                    fi
                done

                # echo "Step 2/3: Starting containers..." >> "$LOG"
                # if docker compose up -d >> "$LOG" 2>&1; then
                #     echo "Docker compose up command accepted." >> "$LOG"
                # else
                #     echo "ERROR: Failed to start containers." >> "$LOG"
                # fi
                echo "Starting Containers..." >> "$LOG"
                for i in $(seq 1 3); do
                    if docker compose up -d >> "$LOG" 2>&1; then
                        echo "Docker Start Command Sent." >> "$LOG"
                        break
                    else
                        echo "Start retry $i..." >> "$LOG"
                        sleep 15
                    fi
                done
                echo "Step 3/3: Verifying startup status..." >> "$LOG"
                sleep 10
                if [ "$(docker ps -q | wc -l)" -gt 0 ]; then
                     echo "SUCCESS: ILM Containers are running." >> "$LOG"
                     # Escape the tabs and braces for Python F-string compatibility
                     docker ps --format "table {{.Names}}\t{{.Status}}" >> "$LOG"
                else
                     echo "WARNING: No running containers found. Check logs with 'docker compose logs'." >> "$LOG"
                fi
                
                echo "ILM setup completed successfully." >> "$LOG"
            else
                echo "ERROR: ILM directory not found. Extracted contents:" >> "$LOG"
                ls -la "$DOWNLOAD_DIR" >> "$LOG"
            fi
        else
            echo "ERROR: Failed to download ILM compose zip file (Timeout or Connection Refused)." >> "$LOG"
        fi
    else
        echo "ILM setup is disabled, skipping..." >> "$LOG"
    fi


# ============================================================================
# RHEL/CENTOS CONFIGURATION (NetworkManager)
# ============================================================================
elif [ "$OS_TYPE" = "rhel" ]; then
    echo "Applying RHEL/CentOS network configuration..." >> "$LOG"

    mkdir -p /etc/cloud/cloud.cfg.d/
    echo "network: {{config: disabled}}" > /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg

    nmcli con mod "$primary_iface" ipv4.method manual ipv4.addresses {ip_with_cidr} ipv4.gateway {gateway} ipv4.dns "{dns_all}"
    nmcli con up "$primary_iface"

    echo "RHEL/CentOS network configuration applied successfully: {ip_with_cidr}" >> "$LOG"

# ============================================================================
# UNKNOWN OS
# ============================================================================
else
    echo "ERROR: Unknown or unsupported OS type: $OS_TYPE" >> "$LOG"
    echo "Skipping network configuration" >> "$LOG"
fi

# ============================================================================
# FINALIZATION
# ============================================================================
echo "Custom network configuration completed" >> "$LOG"

# 1. Register IP with central registry
echo "Registering IP with central registry..." >> "$LOG"
(
    curl -s -X POST http://164.99.91.31:5100/api/res-ip \
    -H "Content-Type: application/json" \
    -d '{{"ip": "{ip_address}", "status": "used"}}' >> "$LOG" 2>&1 || \
    echo "IP registration request failed" >> "$LOG"
) &

# 2. Execute the final sysprep script if it exists
if [ -f /root/linuxsysprep.sh ]; then
    echo "Executing linuxsysprep.sh..." >> "$LOG"
    exec /root/linuxsysprep.sh
fi

echo "VCD Customization Completed" >> "$LOG"
'''
        return script
    def _get_sles_customization_script(self, ip_address, gateway, dns_servers):
        """
        Generate the SLES 15 customization script using sysconfig/network (wicked).

        Args:
            ip_address: IP address to configure (with or without CIDR notation)
            gateway: Gateway IP address
            dns_servers: List of DNS server addresses

        Returns:
            str: Bash script for SLES post-customization
        """
        if "/" not in ip_address:
            ip_with_cidr = f"{ip_address}/21"
        else:
            ip_with_cidr = ip_address

        dns_primary = dns_servers[0] if dns_servers else "15.122.222.53"
        # Extra DNS servers joined with spaces for NETCONFIG_DNS_STATIC_SERVERS
        dns_all = " ".join(dns_servers) if dns_servers else dns_primary

        script = f'''#!/bin/bash
#scriptversion:20171031
#removed precust section as we are now using the deploy log. 
set -euo pipefail
echo "Script Start" >>/root/vcdcustlog
echo "Customization status is: "$1 >>/root/vcdcustlog
echo "Running PostCust check: " >>/root/vcdcustlog

if [  x$1 = x"postcustomization"  ];
then
    echo "VCD Post IF statement accepted" >>/root/vcdcustlog

    echo "Applying custom SLES network configuration..." >>/root/vcdcustlog

    # 1. Disable cloud-init network provisioning
    mkdir -p /etc/cloud/cloud.cfg.d/
    echo "network: {{config: disabled}}" > /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg

    # 2. Remove VMware/Cloud-init interface configs
    rm -f /etc/sysconfig/network/ifcfg-*

    # 3. Detect the primary non-loopback interface
    primary_iface=$(ip -o link | awk -F': ' '$2 != "lo" {{print $2; exit}}')
    if [ -z "$primary_iface" ]; then
        primary_iface=eth0
    fi

    # 4. Write the static configuration
    cat <<EOF > /etc/sysconfig/network/ifcfg-${{primary_iface}}
BOOTPROTO='static'
STARTMODE='auto'
IPADDR='{ip_with_cidr}'
EOF

    # 5. Update gateway
    echo "default {gateway} - -" > /etc/sysconfig/network/routes

    # 6. Update DNS list
    if grep -q "^NETCONFIG_DNS_STATIC_SERVERS=" /etc/sysconfig/network/config; then
        sed -i 's/^NETCONFIG_DNS_STATIC_SERVERS=.*/NETCONFIG_DNS_STATIC_SERVERS="{dns_all}"/' /etc/sysconfig/network/config
    else
        echo "NETCONFIG_DNS_STATIC_SERVERS=\"{dns_all}\"" >> /etc/sysconfig/network/config
    fi
    netconfig update -f

    # 7. Reload Wicked to apply the config
    wicked ifreload all

    echo "Custom SLES Network applied successfully with IP {ip_with_cidr}" >>/root/vcdcustlog

    # Execute the final sysprep script
    exec /root/linuxsysprep.sh
else
    echo "VCD Post IF statement was not accepted" >>/root/vcdcustlog
fi
echo "VCD Customization Completed" >>/root/vcdcustlog
'''
        return script

    def _get_default_customization_script(self, ip_address, gateway, dns_servers):
        """
        Generate the default (Ubuntu/Debian netplan) customization script with dynamic IP configuration.

        Args:
            ip_address: IP address to configure (with or without CIDR notation)
            gateway: Gateway IP address
            dns_servers: List of DNS server addresses

        Returns:
            str: Bash script for post-customization
        """
        # Ensure IP has CIDR notation
        if "/" not in ip_address:
            ip_with_cidr = f"{ip_address}/21"
        else:
            ip_with_cidr = ip_address
        
        # Format DNS servers for YAML
        dns_yaml = "\n          - ".join(dns_servers)
        
        script = f'''#!/bin/bash
#scriptversion:20171031
#removed precust section as we are now using the deploy log. 
echo "Script Start" >>/root/vcdcustlog
echo "Customization status is: "$1 >>/root/vcdcustlog
echo "Running PostCust check: ">>/root/vcdcustlog
 
if [  x$1 = x"postcustomization"  ];
then
        echo "VCD Post IF statement accepted" >>/root/vcdcustlog
        
        echo "Applying custom Netplan configuration..." >>/root/vcdcustlog
        
        # 1. Disable cloud-init network provisioning (prevents future overwrites)
        mkdir -p /etc/cloud/cloud.cfg.d/
        echo "network: {{config: disabled}}" > /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg
        
        # 2. Delete the VMware-generated Netplan files
        rm -f /etc/netplan/99-netcfg-vmware.yaml
        rm -f /etc/netplan/50-cloud-init.yaml
        
        # 3. Create your custom Netplan file using a Heredoc
        cat <<EOF > /etc/netplan/01-custom-network.yaml
network:
  version: 2
  renderer: networkd
  ethernets:
    ens160:
      dhcp4: no
      dhcp6: no
      addresses:
        - {ip_with_cidr}
      gateway4: {gateway}
      nameservers:
        addresses:
          - {dns_yaml}
EOF
        
        # 4. Netplan requires strict permissions on yaml files
        chmod 600 /etc/netplan/01-custom-network.yaml
        
        # 5. Apply the changes immediately
        netplan apply
        
        echo "Custom Netplan applied successfully with IP {ip_with_cidr}" >>/root/vcdcustlog
        
        # 6. Register IP with central registry (non-blocking)
        (echo "Registering IP with central registry..." >>/root/vcdcustlog && curl -s -X POST http://164.99.91.32:5000/res-ip -H "Content-Type: application/json" -d "{{\"ip\": \"{ip_address}\", \"status\": \"used\"}}" >>/root/vcdcustlog 2>&1 || echo "IP registration request sent (may fail if registry unavailable)" >>/root/vcdcustlog) &

        # Execute the final sysprep script
        exec /root/linuxsysprep.sh
else 
        echo "VCD Post IF statement was not accepted" >>/root/vcdcustlog
fi
echo "VCD Customization Completed" >>/root/vcdcustlog
'''
        return script

    def _wait_for_task(self, task_href: str, timeout: int = 60) -> bool:
        """Poll a VCD task href until it succeeds, fails, or times out."""
        if not task_href:
            logger.warning("_wait_for_task: empty task_href, skipping poll")
            return True
        print(f"   -> Waiting for task: {task_href}")
        start = time.time()
        headers = {
            "Accept": f"application/*+xml;version={self.api_version}",
            "Authorization": f"Bearer {self.token}",
        }
        while (time.time() - start) < timeout:
            r = requests.get(task_href, headers=headers, verify=False, timeout=15)
            if r.status_code != 200:
                print(f"   -> Task poll returned HTTP {r.status_code}")
                return False
            text = r.text
            if 'status="success"' in text:
                return True
            if 'status="error"' in text or 'status="aborted"' in text:
                print(f"   -> Task failed: {text[:500]}")
                return False
            time.sleep(2)
        print("   -> Task polling timed out.")
        return False

    def _update_hardware_item(self, vm_href: str, section_name: str, new_value: int) -> str:
        """GET the CPU or memory RASD item XML, patch VirtualQuantity in-place,
        PUT it back, and return the task href from the response.

        Uses regex substitution to preserve original XML namespace prefixes
        (avoids the mangling that xml.etree.ElementTree causes on re-serialization).

        Args:
            vm_href: Full VCD href of the VM
            section_name: 'cpu' or 'memory'
            new_value: New quantity (number of CPUs or MB of RAM)

        Returns:
            task href string (may be empty if the response carries no href)
        """
        import re
        section_url = f"{vm_href}/virtualHardwareSection/{section_name}"
        get_headers = {
            "Accept": f"application/vnd.vmware.vcloud.rasdItem+xml;version={self.api_version}",
            "Authorization": f"Bearer {self.token}",
        }
        r = requests.get(section_url, headers=get_headers, verify=False, timeout=30)
        r.raise_for_status()
        xml_text = r.text

        # Patch VirtualQuantity — namespace-safe regex preserves all prefixes
        xml_text = re.sub(
            r'(<(?:\w+:)?VirtualQuantity(?:\s[^>]*)?>)\d+(</(?:\w+:)?VirtualQuantity>)',
            rf'\g<1>{new_value}\2',
            xml_text,
        )
        label = f"{new_value} virtual CPU(s)" if section_name == "cpu" else f"{new_value} MB of memory"
        xml_text = re.sub(
            r'(<(?:\w+:)?ElementName(?:\s[^>]*)?>)[^<]*(</(?:\w+:)?ElementName>)',
            rf'\g<1>{label}\2',
            xml_text,
        )

        if "VirtualQuantity" not in xml_text:
            raise Exception(f"Could not locate VirtualQuantity in {section_name} XML")

        put_headers = {
            "Accept": f"application/vnd.vmware.vcloud.task+xml;version={self.api_version}",
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/vnd.vmware.vcloud.rasdItem+xml",
        }
        resp = requests.put(
            section_url, headers=put_headers,
            data=xml_text.encode("utf-8"), verify=False, timeout=30,
        )
        resp.raise_for_status()

        # Extract the task href from the response body (first href attribute)
        task_match = re.search(r'href="([^"]+)"', resp.text)
        return task_match.group(1) if task_match else ""

    def update_vm_resources(self, vm_id: str, cpu_count: int | None = None, ram_mb: int | None = None) -> dict:
        """Update CPU and/or RAM on a VM, handling power state automatically.

        Enforces limits: max 4 vCPUs, max 20 GB (20480 MB) RAM.
        If the VM is powered on it will be shut down first and the method waits
        until it is fully powered off before applying the hardware changes.

        Args:
            vm_id: VM UUID (the part after 'vm-' in the href, or the full href —
                   a full href is accepted and the UUID is extracted automatically)
            cpu_count: Desired number of vCPUs (1–4), or None to leave unchanged
            ram_mb: Desired RAM in MB (512–20480), or None to leave unchanged

        Returns:
            dict with status and the applied values
        """
        MAX_CPU = 4
        MAX_RAM_MB = 20480  # 20 GB

        if cpu_count is not None and not (1 <= int(cpu_count) <= MAX_CPU):
            raise ValueError(f"CPU count must be between 1 and {MAX_CPU}")
        if ram_mb is not None and not (512 <= int(ram_mb) <= MAX_RAM_MB):
            raise ValueError(f"RAM must be between 512 MB and {MAX_RAM_MB} MB ({MAX_RAM_MB // 1024} GB)")
        if not cpu_count and not ram_mb:
            return {"status": "noop", "message": "No updates requested"}

        # Accept a full href like https://host/api/vApp/vm-<uuid>
        if vm_id.startswith("http"):
            vm_id = vm_id.split("/vm-", 1)[-1]

        print(f"\nUpdating resources for VM {vm_id}...")
        vm_data = self.get_vm_details(vm_id)
        vm_href = vm_data.get("href", f"https://{self.vcd_host}/api/vApp/vm-{vm_id}")
        vm_status = vm_data.get("status")

        # Status 4 = Powered On — must power off before hardware changes
        was_powered_on = (vm_status == 4)
        if was_powered_on:
            print("   -> VM is Powered ON. Shutting down before resize...")
            self.power_off_vm(vm_href)
            time.sleep(5)  # give VCD a moment to register the task
            for attempt in range(20):
                details = self.get_vm_details(vm_id)
                if details.get("status") == 8:
                    print("   -> VM is now Powered Off.")
                    break
                print(f"   -> Waiting for power-off... (attempt {attempt + 1}/20)")
                time.sleep(3)
            else:
                raise Exception("Timed out waiting for VM to power off.")

        applied: dict = {}
        if cpu_count:
            print(f"   -> Updating CPU to {cpu_count}...")
            task_href = self._update_hardware_item(vm_href, "cpu", int(cpu_count))
            self._wait_for_task(task_href)
            applied["num_cpus"] = cpu_count
            print("   -> CPU update complete.")

        if ram_mb:
            print(f"   -> Updating RAM to {ram_mb} MB...")
            task_href = self._update_hardware_item(vm_href, "memory", int(ram_mb))
            self._wait_for_task(task_href)
            applied["memory_mb"] = ram_mb
            print("   -> RAM update complete.")

        # Restore power state — power back on if the VM was running before the resize
        if was_powered_on:
            print("   -> Powering VM back on...")
            self.power_on_vm(vm_href)
            applied["powered_on"] = True
            print("   -> Power-on command sent.")

        print("Resource update finished successfully.")
        return {"status": "success", "vm_id": vm_id, "vm_href": vm_href, **applied}


def list_vms(vcd_host, token, api_version="38.0", page_size=100, save_to_file=None):
    """
    Convenience function for listing VMs.
    
    Args:
        vcd_host: VCD server hostname
        token: Authentication token
        api_version: VCD API version (default: "38.0")
        page_size: Number of VMs to fetch per page
        save_to_file: Optional filename to save results
    
    Returns:
        list: List of VM records
    """
    vm_ops = VMOperations(vcd_host, token, api_version)
    return vm_ops.list_vms(page_size, save_to_file)


def create_vm(vcd_host, token, vdc_id, template_vm_id, vm_name,
              network_name="BAN2_Vlan90_lr0",
              ip_address=None,  # If None, will try to auto-allocate from registry
              gateway="10.71.39.254",
              power_on=True,
              ip_allocation_mode="MANUAL",  # Set to MANUAL to use auto-allocated IP
              api_version="38.0",
              use_ip_registry=True):
    """
    Convenience function for creating a VM from template.
    
    Args:
        vcd_host: VCD server hostname
        token: Authentication token
        vdc_id: VDC ID where VM will be created
        template_vm_id: VM Template ID (just the UUID part)
        vm_name: Name for the new VM
        network_name: Network name (default: "BAN2_Vlan90_lr0")
        ip_address: Static IP address for MANUAL mode. If None and use_ip_registry=True,
                   will auto-allocate from registry
        gateway: Gateway IP address (default: "10.71.39.254")
        power_on: Power on after creation (default: True)
        ip_allocation_mode: DHCP, POOL, or MANUAL (default: "MANUAL")
        api_version: VCD API version (default: "38.0")
        use_ip_registry: If True and ip_address is None, auto-allocate from IP registry (default: True)
    
    Returns:
        dict: Creation response
    """
    # Auto-allocate IP from registry if not provided and registry is enabled
    if ip_address is None and use_ip_registry:
        try:
            from ip_manager import get_ip_manager
            ip_mgr = get_ip_manager()
            result = ip_mgr.allocate_ip(hostname=vm_name)
            if result.get('status') == 'success' and 'allocated_ip' in result:
                ip_address = result['allocated_ip']
                print(f"Auto-allocated IP from registry: {ip_address}")
            else:
                # Fallback to default if registry is unavailable
                ip_address = "10.71.33.180"
                print(f"Warning: Could not auto-allocate IP, using default: {ip_address}")
        except ImportError:
            # Fallback if ip_manager module not available
            ip_address = "10.71.33.180"
            print(f"Warning: IP registry not available, using default: {ip_address}")
    elif ip_address is None:
        ip_address = "10.71.33.180"
    
    vm_ops = VMOperations(vcd_host, token, api_version)
    return vm_ops.create_vm_from_template(
        vdc_id=vdc_id,
        template_vm_id=template_vm_id,
        vm_name=vm_name,
        network_name=network_name,
        ip_address=ip_address,
        gateway=gateway,
        power_on=power_on,
        ip_allocation_mode=ip_allocation_mode
    )
