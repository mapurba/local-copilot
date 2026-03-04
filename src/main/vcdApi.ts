import https from 'https';
import { URL } from 'url';
import { getVcdContext, setPendingForm, getPendingForm, VcdCreateForm } from './vcdStore';

interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function buildAgent(rejectUnauthorized?: boolean) {
  return new https.Agent({ rejectUnauthorized: rejectUnauthorized ?? false });
}

function httpsRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
  timeoutMs = 30000,
  rejectUnauthorized?: boolean
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method,
        headers,
        agent: buildAgent(rejectUnauthorized),
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          resolve({ status: res.statusCode || 0, headers: res.headers, body: data });
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timeout after ${timeoutMs}ms`));
    });
    if (body) req.write(body);
    req.end();
  });
}

function jsonParseSafe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function baseHeaders(apiVersion: string, token: string, accept: string): Record<string, string> {
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
  };
}

function addTenantHeaders(
  headers: Record<string, string>,
  orgName?: string,
  orgUuid?: string
): Record<string, string> {
  if (orgName) headers['x-vmware-vcloud-auth-context'] = orgName;
  if (orgUuid) headers['x-vmware-vcloud-tenant-context'] = orgUuid;
  return headers;
}

function sanitizeComputerName(vmName: string): string {
  const cleaned = vmName.replace(/[^a-zA-Z0-9\-.]/g, '-').replace(/^-+|-+$/g, '');
  if (!cleaned || /^\d+$/.test(cleaned)) {
    return `vm-${cleaned || 'host'}`;
  }
  return cleaned;
}

const SLES_PATTERNS = ['sles_15', 'sles15', 'sles', 'suse', 'sp5', 'sp6', 'sp7'];

function isSlesTemplate(templateName?: string): boolean {
  if (!templateName) return false;
  const lower = templateName.toLowerCase();
  return SLES_PATTERNS.some((p) => lower.startsWith(p) || lower.includes(p));
}

function matchesOwner(ownerName: string, username: string): boolean {
  if (!ownerName || !username) return false;
  const ownerLower = ownerName.toLowerCase();
  const userLower = username.toLowerCase();
  return (
    ownerLower === userLower ||
    ownerLower.startsWith(`${userLower}@`) ||
    ownerLower.endsWith(`\\${userLower}`) ||
    ownerLower.endsWith(`/${userLower}`)
  );
}

async function queryRecords(
  recordType: string,
  pageSize = 128,
  extraFilter?: string,
  sortDesc?: string
): Promise<Record<string, unknown>[]> {
  const ctx = getVcdContext();
  const url = new URL(`https://${ctx.host}/api/query`);
  url.searchParams.set('type', recordType);
  url.searchParams.set('format', 'records');
  url.searchParams.set('pageSize', String(pageSize));
  if (extraFilter) url.searchParams.set('filter', extraFilter);
  if (sortDesc) url.searchParams.set('sortDesc', sortDesc);

  const headers = baseHeaders(ctx.apiVersion, ctx.token, `application/*+json;version=${ctx.apiVersion}`);
  const result = await httpsRequest(url.toString(), 'GET', headers, undefined, 30000, ctx.rejectUnauthorized);
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`query_records(${recordType}) failed: HTTP ${result.status}`);
  }
  const data = jsonParseSafe(result.body) as { record?: Record<string, unknown>[] } | null;
  return data?.record || [];
}

export async function listVms(pageSize = 100, saveToFile?: string): Promise<unknown> {
  const ctx = getVcdContext();
  const username = ctx.username || '';
  const records = await queryRecords(
    'vm',
    pageSize,
    username ? `ownerName==*${username}*;isVAppTemplate==false` : 'isVAppTemplate==false',
    'dateCreated'
  );

  const userVms = username
    ? records.filter((vm) => matchesOwner(String(vm.ownerName || ''), username))
    : records;

  // Normalize the VMs to extract powered_on status from the status field
  const normalizedVms = userVms.map((vm) => normalizeVmStatus(vm));

  if (saveToFile) {
    return { count: normalizedVms.length, vms: normalizedVms, save_to_file: saveToFile };
  }
  console.log(`Found ${normalizedVms.length} VMs for user ${username}, normalized vm details=${JSON.stringify(normalizedVms)}`);
  return { count: normalizedVms.length, vms: normalizedVms };
}

export async function getVmDetails(vmId: string): Promise<Record<string, unknown>> {
  const ctx = getVcdContext();
  const id = vmId.startsWith('http') ? vmId.split('/vm-')[1] : vmId;
  const url = `https://${ctx.host}/api/vApp/vm-${id}`;
  const headers = baseHeaders(ctx.apiVersion, ctx.token, `application/*+json;version=${ctx.apiVersion}`);
  const result = await httpsRequest(url, 'GET', headers, undefined, 30000, ctx.rejectUnauthorized);
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`get_vm_details failed: HTTP ${result.status}`);
  }
  const data = jsonParseSafe(result.body) as Record<string, unknown> | null;
  if (!data) throw new Error('get_vm_details returned invalid JSON');
  return data;
}

export async function powerOnVm(vmHref: string): Promise<Record<string, unknown>> {
  const ctx = getVcdContext();
  const url = `${vmHref}/power/action/powerOn`;
  const headers = {
    ...baseHeaders(ctx.apiVersion, ctx.token, `application/*+json;version=${ctx.apiVersion}`),
    'Content-Length': '0',
  };
  const result = await httpsRequest(url, 'POST', headers, '', 30000, ctx.rejectUnauthorized);
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`power_on failed: HTTP ${result.status}`);
  }
  return { status: 'success', action: 'powerOn', vm_href: vmHref };
}

export async function powerOffVm(vmHref: string): Promise<Record<string, unknown>> {
  const ctx = getVcdContext();
  const url = `${vmHref}/power/action/powerOff`;
  const headers = {
    ...baseHeaders(ctx.apiVersion, ctx.token, `application/*+json;version=${ctx.apiVersion}`),
    'Content-Length': '0',
  };
  const result = await httpsRequest(url, 'POST', headers, '', 30000, ctx.rejectUnauthorized);
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`power_off failed: HTTP ${result.status}`);
  }
  return { status: 'success', action: 'powerOff', vm_href: vmHref };
}

export async function listTemplates(nameFilter = ''): Promise<Record<string, unknown>> {
  const ctx = getVcdContext();
  const filter = nameFilter.trim()
    ? `((isExpired==false);(name==*${nameFilter.trim()}*))`
    : '((isExpired==false))';

  const url = new URL(`https://${ctx.host}/api/query`);
  url.searchParams.set('type', 'vAppTemplate');
  url.searchParams.set('format', 'records');
  url.searchParams.set('page', '1');
  url.searchParams.set('pageSize', '15');
  url.searchParams.set('filterEncoded', 'true');
  url.searchParams.set('filter', filter);
  url.searchParams.set('sortAsc', 'name');
  url.searchParams.set('links', 'true');

  const headers = baseHeaders(ctx.apiVersion, ctx.token, `application/*+json;version=${ctx.apiVersion}`);
  const result = await httpsRequest(url.toString(), 'GET', headers, undefined, 30000, ctx.rejectUnauthorized);

  if (result.status < 200 || result.status >= 300) {
    throw new Error(`list_templates failed: HTTP ${result.status}`);
  }

  const data = jsonParseSafe(result.body) as { record?: Record<string, unknown>[]; total?: number } | null;
  const records = data?.record || [];

  const templates = records.map((t) => {
    const href = String(t.href || '');
    let templateId = href.includes('/vAppTemplate/') ? href.split('/vAppTemplate/').pop() || '' : '';
    for (const prefix of ['vappTemplate-', 'vm-']) {
      if (templateId.startsWith(prefix)) {
        templateId = templateId.slice(prefix.length);
        break;
      }
    }
    const other = (t.otherAttributes as Record<string, unknown> | undefined) || {};
    return {
      name: String(t.name || ''),
      template_id: templateId,
      catalog: String(t.catalogName || ''),
      status: String(t.status || ''),
      description: String(t.description || ''),
      cpus: other.numberOfCpus ?? '',
      memory_mb: other.memoryAllocationMB ?? '',
    };
  });

  return { count: templates.length, total: data?.total ?? templates.length, templates };
}

async function resolveTemplateVmHref(vappTemplateUuid: string): Promise<string> {
  const ctx = getVcdContext();
  const url = `https://${ctx.host}/api/vAppTemplate/vappTemplate-${vappTemplateUuid}`;
  const headers = addTenantHeaders(
    baseHeaders(ctx.apiVersion, ctx.token, `application/*+xml;version=${ctx.apiVersion}`),
    ctx.orgName,
    ctx.orgUuid
  );
  const result = await httpsRequest(url, 'GET', headers, undefined, 15000, ctx.rejectUnauthorized);
  if (result.status >= 200 && result.status < 300) {
    const match = result.body.match(/<Vm[^>]*href="([^"]*\/vm-[^"]+)"/i);
    if (match && match[1]) return match[1];
  }
  return `https://${ctx.host}/api/vAppTemplate/vm-${vappTemplateUuid}`;
}

function getUnifiedCustomizationScript(
  ipAddress: string,
  gateway: string,
  dnsServers: string[],
  setupIlm = false,
  ilmVersion = 'latest'
): string {
  const ipWithCidr = ipAddress.includes('/') ? ipAddress : `${ipAddress}/21`;
  const dnsPrimary = dnsServers.length ? dnsServers[0] : '15.122.222.53';
  const dnsAll = dnsServers.length ? dnsServers.join(' ') : dnsPrimary;
  const dnsYaml = dnsServers.length ? dnsServers.join('\n          - ') : dnsPrimary;
  const ilmEnabled = setupIlm ? 'true' : 'false';
  const ilmVersionMapped = ilmVersion === 'latest' ? '1.3.0' : ilmVersion;
  const versionMapping: Record<string, { url: string; full: string }> = {
    '1.3.0': {
      url: 'https://blr-idm-jenkins.labs.blr.novell.com:8443/job/ILM/job/ilm-containers-1.3.0/lastSuccessfulBuild/artifact/com/opentext/ilm/compose/1.3.0.0000/compose-1.3.0.0000.zip',
      full: '1.3.0.0000',
    },
    '1.2.0': {
      url: 'https://blr-idm-jenkins.labs.blr.novell.com:8443/job/ILM/job/ilm-containers-1.2.0/lastSuccessfulBuild/artifact/com/opentext/ilm/compose/1.2.0.0000/compose-1.2.0.0000.zip',
      full: '1.2.0.0000',
    },
    '1.0.0': {
      url: 'https://blr-idm-jenkins.labs.blr.novell.com:8443/job/ILM/job/ilm-containers/lastSuccessfulBuild/artifact/com/opentext/ilm/compose/1.0.0.0000/compose-1.0.0.0000.zip',
      full: '1.0.0.0000',
    },
  };
  const ilmEntry = versionMapping[ilmVersionMapped] || versionMapping['1.3.0'];

  let script = `#!/bin/bash
#scriptversion:20250302-unified-fixed-final
#Auto-detecting customization script for VCD guest OS
set -u

LOG="/root/vcdcustlog"
touch "$LOG"

echo "Script Start" >> "$LOG"
echo "Customization status is: __DOLLAR_CURLY__1:-}" >> "$LOG"
echo "Running PostCust check" >> "$LOG"

# Fix: Use __DOLLAR_CURLY__1:-} to handle empty variable safely
if [ "x__DOLLAR_CURLY__1:-}" != "xpostcustomization" ]; then
    echo "VCD Post IF statement was not accepted" >> "$LOG"
    exit 0
fi

echo "VCD Post IF statement accepted" >> "$LOG"

# ============================================================================
# ILM SETUP CONFIGURATION VARIABLES
# ============================================================================
SETUP_ILM="__ILM_ENABLED__"
ILM_VERSION="__ILM_VERSION__"
ILM_FULL_VERSION="__ILM_FULL_VERSION__"
ILM_COMPOSE_URL="__ILM_URL__"
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
primary_iface=$(ip -o link | awk '$2 != "lo:" && $2 !~ /^lo@/ {print $2; exit}' | sed 's/://' | sed 's/@.*//')
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
    echo "network: {config: disabled}" > /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg

    if systemctl is-active --quiet NetworkManager; then
        echo "NetworkManager detected (GNOME environment). Using nmcli..." >> "$LOG"
        nmcli con mod "$primary_iface" ipv4.method manual ipv4.addresses __IP_WITH_CIDR__ ipv4.gateway __GATEWAY__ ipv4.dns "__DNS_ALL__"
        nmcli con up "$primary_iface"
        echo "SLES (NetworkManager) configured successfully: __IP_WITH_CIDR__" >> "$LOG"
    else
        echo "Wicked detected (Server environment). Using sysconfig..." >> "$LOG"
        rm -f /etc/sysconfig/network/ifcfg-eth*
        rm -f /etc/sysconfig/network/ifcfg-ens*

        cat <<EOF > /etc/sysconfig/network/ifcfg-$primary_iface
BOOTPROTO='static'
STARTMODE='auto'
IPADDR='__IP_WITH_CIDR__'
EOF
        echo "default __GATEWAY__ - -" > /etc/sysconfig/network/routes
        
        if grep -q "^NETCONFIG_DNS_STATIC_SERVERS=" /etc/sysconfig/network/config; then
            sed -i 's/^NETCONFIG_DNS_STATIC_SERVERS=.*/NETCONFIG_DNS_STATIC_SERVERS="__DNS_ALL__"/' /etc/sysconfig/network/config
        else
            echo "NETCONFIG_DNS_STATIC_SERVERS=\"__DNS_ALL__\"" >> /etc/sysconfig/network/config
        fi
        netconfig update -f
        wicked ifreload all
        echo "SLES (Wicked) configured successfully: __IP_WITH_CIDR__" >> "$LOG"
    fi

# ============================================================================
# UBUNTU/DEBIAN CONFIGURATION (netplan)
# ============================================================================
elif [ "$OS_TYPE" = "ubuntu" ]; then
    echo "Applying Ubuntu/Debian network configuration..." >> "$LOG"

    export DEBIAN_FRONTEND=noninteractive

    mkdir -p /etc/cloud/cloud.cfg.d/
    echo "network: {config: disabled}" > /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg

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
    echo "Ubuntu/Debian network configuration applied successfully: __IP_WITH_CIDR__" >> "$LOG"
    
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
    echo "network: {config: disabled}" > /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg

    nmcli con mod "$primary_iface" ipv4.method manual ipv4.addresses __IP_WITH_CIDR__ ipv4.gateway __GATEWAY__ ipv4.dns "__DNS_ALL__"
    nmcli con up "$primary_iface"

    echo "RHEL/CentOS network configuration applied successfully: __IP_WITH_CIDR__" >> "$LOG"

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
    -d '{"ip": "__IP_ADDRESS__", "status": "used"}' >> "$LOG" 2>&1 || \
    echo "IP registration request failed" >> "$LOG"
) &

# 2. Execute the final sysprep script if it exists
if [ -f /root/linuxsysprep.sh ]; then
    echo "Executing linuxsysprep.sh..." >> "$LOG"
    exec /root/linuxsysprep.sh
fi

echo "VCD Customization Completed" >> "$LOG"
`;

  script = script
    .replace(/__IP_WITH_CIDR__/g, ipWithCidr)
    .replace(/__GATEWAY__/g, gateway)
    .replace(/__DNS_ALL__/g, dnsAll)
    .replace(/__DNS_YAML__/g, dnsYaml)
    .replace(/__IP_ADDRESS__/g, ipAddress)
    .replace(/__ILM_ENABLED__/g, ilmEnabled)
    .replace(/__ILM_VERSION__/g, ilmVersionMapped)
    .replace(/__ILM_FULL_VERSION__/g, ilmEntry.full)
    .replace(/__ILM_URL__/g, ilmEntry.url)
    .replace(/__DOLLAR_CURLY__/g, '${');

  return script;
}

async function waitForTask(taskHref: string, timeoutSec = 60): Promise<boolean> {
  if (!taskHref) return true;
  const ctx = getVcdContext();
  const headers = baseHeaders(ctx.apiVersion, ctx.token, `application/*+xml;version=${ctx.apiVersion}`);
  const start = Date.now();
  while ((Date.now() - start) / 1000 < timeoutSec) {
    const result = await httpsRequest(taskHref, 'GET', headers, undefined, 15000, ctx.rejectUnauthorized);
    if (result.status !== 200) return false;
    if (result.body.includes('status="success"')) return true;
    if (result.body.includes('status="error"') || result.body.includes('status="aborted"')) return false;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function updateHardwareItem(vmHref: string, sectionName: 'cpu' | 'memory', newValue: number): Promise<string> {
  const ctx = getVcdContext();
  const sectionUrl = `${vmHref}/virtualHardwareSection/${sectionName}`;
  const getHeaders = baseHeaders(
    ctx.apiVersion,
    ctx.token,
    `application/vnd.vmware.vcloud.rasdItem+xml;version=${ctx.apiVersion}`
  );
  const getRes = await httpsRequest(sectionUrl, 'GET', getHeaders, undefined, 30000, ctx.rejectUnauthorized);
  if (getRes.status < 200 || getRes.status >= 300) {
    throw new Error(`Failed to fetch ${sectionName} section: HTTP ${getRes.status}`);
  }
  let xml = getRes.body;
  xml = xml.replace(
    /(<(?:\w+:)?VirtualQuantity(?:\s[^>]*)?>)\d+(<\/(?:\w+:)?VirtualQuantity>)/,
    `$1${newValue}$2`
  );
  const label = sectionName === 'cpu' ? `${newValue} virtual CPU(s)` : `${newValue} MB of memory`;
  xml = xml.replace(
    /(<(?:\w+:)?ElementName(?:\s[^>]*)?>)[^<]*(<\/(?:\w+:)?ElementName>)/,
    `$1${label}$2`
  );

  if (!xml.includes('VirtualQuantity')) {
    throw new Error(`VirtualQuantity not found in ${sectionName} XML`);
  }

  const putHeaders = {
    ...baseHeaders(ctx.apiVersion, ctx.token, `application/vnd.vmware.vcloud.task+xml;version=${ctx.apiVersion}`),
    'Content-Type': 'application/vnd.vmware.vcloud.rasdItem+xml',
  };
  const putRes = await httpsRequest(sectionUrl, 'PUT', putHeaders, xml, 30000, ctx.rejectUnauthorized);
  if (putRes.status < 200 || putRes.status >= 300) {
    throw new Error(`Failed to update ${sectionName}: HTTP ${putRes.status}`);
  }
  const match = putRes.body.match(/href="([^"]+)"/);
  return match?.[1] || '';
}

export async function checkVmStatus(vmName: string): Promise<Record<string, unknown>> {
  const records = await queryRecords('vm', 128);
  const found = records.find((vm) => String(vm.name || '') === vmName);
  if (!found) {
    return { found: false, vm_name: vmName };
  }
  return { found: true, vm: normalizeVmStatus(found) };
}

async function resolveVmHrefByName(nameOrHref: string): Promise<string> {
  if (nameOrHref.startsWith('http')) {
    return nameOrHref;
  }
  const ctx = getVcdContext();
  const username = ctx.username || '';
  const records = await queryRecords(
    'vm',
    200,
    username ? `ownerName==*${username}*;isVAppTemplate==false` : 'isVAppTemplate==false',
    'dateCreated'
  );
  const needle = nameOrHref.toLowerCase();
  const matches = records.filter((vm) => {
    const sameName = String(vm.name || '').toLowerCase() === needle;
    if (!sameName) return false;
    return username ? matchesOwner(String(vm.ownerName || ''), username) : true;
  });

  if (matches.length === 0) {
    throw new Error(`No VM named '${nameOrHref}' found for the current user.`);
  }
  if (matches.length > 1) {
    const hrefs = matches.map((vm) => String(vm.href || '?'));
    throw new Error(
      `Ambiguous: ${matches.length} VMs are named '${nameOrHref}'. Please use exact vm_href. Found hrefs: ${hrefs.join(', ')}`
    );
  }
  const href = String(matches[0].href || '');
  if (!href) {
    throw new Error(`VM '${nameOrHref}' was found but has no href.`);
  }
  return href;
}

export async function updateVmResources(vmId: string, cpuCount?: number, ramMb?: number): Promise<Record<string, unknown>> {
  const MAX_CPU = 4;
  const MAX_RAM_MB = 20480;

  if (cpuCount !== undefined && (cpuCount < 1 || cpuCount > MAX_CPU)) {
    throw new Error(`CPU count must be between 1 and ${MAX_CPU}`);
  }
  if (ramMb !== undefined && (ramMb < 512 || ramMb > MAX_RAM_MB)) {
    throw new Error(`RAM must be between 512 MB and ${MAX_RAM_MB} MB`);
  }
  if (!cpuCount && !ramMb) {
    return { status: 'noop', message: 'No updates requested' };
  }

  const ctx = getVcdContext();
  const vmHref = await resolveVmHrefByName(vmId);
  const id = vmHref.includes('/vm-') ? vmHref.split('/vm-')[1] : vmId;
  const vmData = await getVmDetails(id);
  const vmStatus = vmData.status;

  const wasPoweredOn = vmStatus === 4 || vmStatus === '4';
  if (wasPoweredOn) {
    await powerOffVm(vmHref);
    await new Promise((r) => setTimeout(r, 5000));
    for (let i = 0; i < 20; i += 1) {
      const details = await getVmDetails(id);
      if (details.status === 8 || details.status === '8') break;
      await new Promise((r) => setTimeout(r, 3000));
      if (i === 19) throw new Error('Timed out waiting for VM to power off');
    }
  }

  const applied: Record<string, unknown> = {};
  if (cpuCount) {
    const taskHref = await updateHardwareItem(vmHref, 'cpu', cpuCount);
    await waitForTask(taskHref);
    applied.num_cpus = cpuCount;
  }
  if (ramMb) {
    const taskHref = await updateHardwareItem(vmHref, 'memory', ramMb);
    await waitForTask(taskHref);
    applied.memory_mb = ramMb;
  }

  if (wasPoweredOn) {
    await powerOnVm(vmHref);
    applied.powered_on = true;
  }

  return { status: 'success', vm_id: id, vm_href: vmHref, ...applied };
}

export async function createVmFromTemplate(params: {
  vdc_id: string;
  template_vm_id: string;
  vm_name: string;
  template_name?: string;
  org_name?: string;
  org_uuid?: string;
  network_name: string;
  ip_address: string;
  gateway: string;
  dns_servers: string[];
  power_on: boolean;
  ip_allocation_mode: string;
  network_adapter_type: string;
  storage_profile_id: string;
  compute_policy_id: string;
  setup_ilm?: boolean;
  ilm_version?: string;
  custom_script?: string;
}): Promise<Record<string, unknown>> {
  const ctx = getVcdContext();

  const templateHref = await resolveTemplateVmHref(params.template_vm_id);
  let childVmUuid = templateHref.split('/').pop() || '';
  if (childVmUuid.startsWith('vm-')) childVmUuid = childVmUuid.slice(3);

  const storageProfileHref = `https://${ctx.host}/api/vdcStorageProfile/${params.storage_profile_id}`;
  const ipSection = params.ip_allocation_mode === 'MANUAL'
    ? `<IpAddress>${params.ip_address}</IpAddress>`
    : '<IpAddress/>';

  let customizationScript = params.custom_script;
  if (!customizationScript) {
    customizationScript = getUnifiedCustomizationScript(
      params.ip_address,
      params.gateway,
      params.dns_servers,
      params.setup_ilm,
      params.ilm_version
    );
  }

  const computerName = sanitizeComputerName(params.vm_name);
  const xmlPayload = `<?xml version="1.0" encoding="UTF-8"?>
<InstantiateVmTemplateParams
    xmlns="http://www.vmware.com/vcloud/v1.5"
    xmlns:ovf="http://schemas.dmtf.org/ovf/envelope/1"
    name="${params.vm_name}"
    powerOn="${String(params.power_on).toLowerCase()}">
    <Description>VM created from template</Description>
    <SourcedVmTemplateItem>
        <Source
            href="${templateHref}"
            id="urn:vcloud:vm:${childVmUuid}"
            type="application/vnd.vmware.vcloud.vm+xml"/>
        <VmTemplateInstantiationParams>
            <NetworkConnectionSection>
                <ovf:Info/>
                <PrimaryNetworkConnectionIndex>0</PrimaryNetworkConnectionIndex>
                <NetworkConnection network="${params.network_name}">
                    <NetworkConnectionIndex>0</NetworkConnectionIndex>
                    ${ipSection}
                    <IpType>IPV4</IpType>
                    <IsConnected>true</IsConnected>
                    <IpAddressAllocationMode>${params.ip_allocation_mode}</IpAddressAllocationMode>
                    <NetworkAdapterType>${params.network_adapter_type}</NetworkAdapterType>
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
                <CustomizationScript><![CDATA[${customizationScript}]]></CustomizationScript>
                <ComputerName>${computerName}</ComputerName>
            </GuestCustomizationSection>
        </VmTemplateInstantiationParams>
        <StorageProfile
            href="${storageProfileHref}"
            type="application/vnd.vmware.vcloud.vdcStorageProfile+xml"/>
    </SourcedVmTemplateItem>
    <AllEULAsAccepted>true</AllEULAsAccepted>
    <ComputePolicy>
        <VmSizingPolicy
            href="urn:vcloud:vdcComputePolicy:${params.compute_policy_id}"
            id="urn:vcloud:vdcComputePolicy:${params.compute_policy_id}"/>
    </ComputePolicy>
</InstantiateVmTemplateParams>`;

  const headers = addTenantHeaders(
    {
      ...baseHeaders(ctx.apiVersion, ctx.token, `application/*+xml;version=${ctx.apiVersion}`),
      'Content-Type': 'application/*+xml;charset=UTF-8',
    },
    params.org_name || ctx.orgName,
    params.org_uuid || ctx.orgUuid
  );

  const url = `https://${ctx.host}/api/vdc/${params.vdc_id}/action/instantiateVmFromTemplate`;
  const result = await httpsRequest(url, 'POST', headers, xmlPayload, 30000, ctx.rejectUnauthorized);
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`create_vm failed: HTTP ${result.status} - ${result.body.slice(0, 500)}`);
  }
  return {
    status: 'success',
    status_code: result.status,
    response_text: result.body.slice(0, 500),
  };
}

export async function createVmDraft(form: VcdCreateForm): Promise<Record<string, unknown>> {
  setPendingForm(form);
  return {
    type: 'vm_create_form',
    message: 'Review the VM details and confirm to create the VM.',
    form,
  };
}

export async function createVmConfirmed(): Promise<Record<string, unknown>> {
  const ctx = getVcdContext();
  const form = getPendingForm();
  if (!form) {
    return { status: 'error', message: 'No pending VM form found. Create a draft first.' };
  }
  if (!ctx.vdcId) {
    return { status: 'error', message: 'Missing VDC ID. Set vdc_id via set_vcd_context.' };
  }
  if (!form.template_id) {
    return { status: 'error', message: 'Missing template_id in draft. Create a draft with a template first.' };
  }
  const networkName = form.network_name || ctx.networkName;
  if (!networkName) {
    return { status: 'error', message: 'Missing network name. Set network_name via set_vcd_context or draft.' };
  }
  const gateway = form.gateway || ctx.gateway || '';
  const ipAddress = form.ip_address || '10.71.33.180';
  const dnsList = (form.dns_servers ? form.dns_servers.split(',') : ctx.dnsServers) || ['15.122.222.53'];
  const storageProfileId = form.storage_profile_id || ctx.storageProfileId || '';
  const computePolicyId = form.compute_policy_id || ctx.computePolicyId || '';
  if (!storageProfileId || !computePolicyId) {
    return { status: 'error', message: 'Missing storage_profile_id or compute_policy_id. Set via set_vcd_context.' };
  }

  const result = await createVmFromTemplate({
    vdc_id: ctx.vdcId,
    template_vm_id: form.template_id,
    vm_name: form.vm_name,
    template_name: form.template_name || '',
    org_name: ctx.orgName,
    org_uuid: ctx.orgUuid,
    network_name: networkName,
    ip_address: ipAddress,
    gateway,
    dns_servers: dnsList,
    power_on: form.power_on ?? true,
    ip_allocation_mode: form.ip_allocation_mode || 'DHCP',
    network_adapter_type: 'VMXNET3',
    storage_profile_id: storageProfileId,
    compute_policy_id: computePolicyId,
    setup_ilm: form.setup_ilm,
    ilm_version: form.ilm_version,
  });

  setPendingForm(null);
  return { status: 'success', result };
}

export async function listTasks(minutesAgo = 60, pageSize = 50): Promise<Record<string, unknown>> {
  const ctx = getVcdContext();
  const since = new Date(Date.now() - minutesAgo * 60 * 1000);
  const iso = since.toISOString().replace(/\.\d{3}Z$/, '.00');

  const url = new URL(`https://${ctx.host}/api/query`);
  url.searchParams.set('type', 'task');
  url.searchParams.set('format', 'records');
  url.searchParams.set('page', '1');
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.set('filterEncoded', 'true');
  url.searchParams.set('filter', `startDate=gt=${iso}`);

  const headers = baseHeaders(ctx.apiVersion, ctx.token, `application/*+json;version=${ctx.apiVersion}`);
  const result = await httpsRequest(url.toString(), 'GET', headers, undefined, 30000, ctx.rejectUnauthorized);
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`list_tasks failed: HTTP ${result.status}`);
  }

  const data = jsonParseSafe(result.body) as { record?: Record<string, unknown>[]; total?: number } | null;
  const records = data?.record || [];
  const items = records.map((t) => ({
    name: t.name,
    status: t.status,
    operation: t.operation,
    ownerName: t.ownerName,
    startDate: t.startDate,
    href: t.href,
  }));

  return { count: items.length, total: data?.total ?? items.length, since_minutes_ago: minutesAgo, tasks: items };
}

export function normalizeVmStatus(vm: Record<string, unknown>): Record<string, unknown> {
  const name = String(vm.name || 'Unknown');
  const href = String(vm.href || '');
  const rawStatus = String(vm.status || '');

  // Parse the status field to determine power state
  // Status values: "POWERED_ON", "POWERED_OFF", etc.
  const statusNormalized = rawStatus.toLowerCase().replace(/\s+|_/g, '');
  const poweredOn = ['4', 'poweredon', 'poweron', 'on'].includes(statusNormalized);

  return {
    name,
    status: rawStatus,
    powered_on: poweredOn,
    href,
    ip: vm.ipAddress || vm.ip || '',
    owner: vm.ownerName || '',
  };
}

export function buildCreateFormFromInput(form: Partial<VcdCreateForm>): VcdCreateForm {
  const ctx = getVcdContext();
  return {
    vm_name: form.vm_name || '',
    template_id: form.template_id || '',
    template_name: form.template_name || '',
    network_name: form.network_name || ctx.networkName || '',
    ip_allocation_mode: form.ip_allocation_mode || 'DHCP',
    ip_address: form.ip_address || '',
    gateway: form.gateway || ctx.gateway || '',
    dns_servers: form.dns_servers || (ctx.dnsServers ? ctx.dnsServers.join(',') : ''),
    power_on: form.power_on ?? true,
    storage_profile_id: form.storage_profile_id || ctx.storageProfileId || '',
    compute_policy_id: form.compute_policy_id || ctx.computePolicyId || '',
    setup_ilm: form.setup_ilm ?? false,
    ilm_version: form.ilm_version || 'latest',
  };
}

export function shouldUseSlesScript(templateName?: string): boolean {
  return isSlesTemplate(templateName);
}
