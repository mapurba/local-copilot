"""
Configuration module for VMware Cloud Director scripts.
Loads configuration from environment variables with fallback to defaults.

Usage:
    from config import config
    
    # Access configuration
    vcd_host = config.VCD_HOST
    username = config.VCD_USERNAME
"""
import os
from pathlib import Path
from typing import List

# Try to load .env file if it exists
try:
    from dotenv import load_dotenv
    # Look for .env file in the script directory
    env_path = Path(__file__).parent / '.env'
    if env_path.exists():
        load_dotenv(env_path)
        print(f"[OK] Loaded configuration from {env_path}")
    else:
        print("[INFO] No .env file found, using defaults or environment variables")
except ImportError:
    print("[INFO] python-dotenv not installed. Install with: pip install python-dotenv")
    print("[INFO] Using environment variables or defaults")


class Config:
    """
    Configuration class that loads from environment variables with fallback to defaults.
    """
    
    # VCD Server Configuration
    VCD_HOST: str = os.getenv('VCD_HOST', 'ban-vcd.otxlab.net')
    ORG_NAME: str = os.getenv('ORG_NAME', 'ban2_identity_edir')
    
    # Credentials (no defaults for security - must be provided)
    VCD_USERNAME: str = os.getenv('VCD_USERNAME', '')
    VCD_PASSWORD: str = os.getenv('VCD_PASSWORD', '')
    
    # API Configuration
    API_VERSION: str = os.getenv('API_VERSION', '38.0')
    
    # VM Creation Defaults
    VDC_ID: str = os.getenv('VDC_ID', '34a51351-8747-4fef-966f-742a9b1ba059')

    # Per-org VDC ID mapping (org name -> VDC UUID)
    VDC_ID_MAP: dict = {
        'ban2_identity_edir': '34a51351-8747-4fef-966f-742a9b1ba059',
        'ban2_identity_ilm':  '7844a49e-a3f2-48c1-89a8-5850e23fe3ff',
        'ban2_identity_idm':  '023d9885-8ad6-4ef8-9154-2c1d8f9205d3',
    }

    # Per-org Org UUID mapping (used for x-vmware-vcloud-tenant-context header)
    ORG_UUID_MAP: dict = {
        'ban2_identity_edir': '',   # populate if cross-tenant calls fail
        'ban2_identity_ilm':  'fbf2e477-e45e-41a4-be7d-d8b3bc3e4197',
        'ban2_identity_idm':  '',
    }
    TEMPLATE_VM_ID: str = os.getenv('TEMPLATE_VM_ID', 'f0d3d261-f5ec-4ed0-a713-1291beae6683')
    NETWORK_NAME: str = os.getenv('NETWORK_NAME', 'BAN2_Vlan90_lr0')
    NETWORK_ADAPTER_TYPE: str = os.getenv('NETWORK_ADAPTER_TYPE', 'VMXNET3')
    IP_ALLOCATION_MODE: str = os.getenv('IP_ALLOCATION_MODE', 'DHCP')
    
    # Storage and Compute
    STORAGE_PROFILE_ID: str = os.getenv('STORAGE_PROFILE_ID', '90895948-aca6-468f-9b3f-edc538b28300')
    COMPUTE_POLICY_ID: str = os.getenv('COMPUTE_POLICY_ID', '99d7f24e-f634-40b4-bebe-e1e06d27c26f')

    # Per-org Storage Profile mapping
    STORAGE_PROFILE_ID_MAP: dict = {
        'ban2_identity_edir': '90895948-aca6-468f-9b3f-edc538b28300',
        'ban2_identity_ilm':  '1f35699f-390d-446f-a813-de772f2470b4',
        'ban2_identity_idm':  'ae6341bb-b5b9-423e-9651-3ee1a57cf983',
    }

    # Per-org Compute Policy mapping
    COMPUTE_POLICY_ID_MAP: dict = {
        'ban2_identity_edir': '99d7f24e-f634-40b4-bebe-e1e06d27c26f',
        'ban2_identity_ilm':  '0d22b7d1-67b7-4776-a05b-8d86ed36ef53',
        'ban2_identity_idm':  '9da3314f-2883-4083-94b5-c7b4af2b4878',
    }
    
    # ILM (Identity Lifecycle Manager) Configuration
    ILM_VERSIONS: dict = {
        '1.3.0': 'https://blr-idm-jenkins.labs.blr.novell.com:8443/job/ILM/job/ilm-containers-1.3.0/lastSuccessfulBuild/artifact/com/opentext/ilm/compose/1.3.0.0000/compose-1.3.0.0000.zip',
        '1.2.0': 'https://blr-idm-jenkins.labs.blr.novell.com:8443/job/ILM/job/ilm-containers-1.2.0/lastSuccessfulBuild/artifact/com/opentext/ilm/compose/1.2.0.0000/compose-1.2.0.0000.zip',
        'default': 'https://blr-idm-jenkins.labs.blr.novell.com:8443/job/ILM/job/ilm-containers/lastSuccessfulBuild/artifact/com/opentext/ilm/compose/1.0.0.0000/compose-1.0.0.0000.zip',
        'latest': 'https://blr-idm-jenkins.labs.blr.novell.com:8443/job/ILM/job/ilm-containers-1.3.0/lastSuccessfulBuild/artifact/com/opentext/ilm/compose/1.3.0.0000/compose-1.3.0.0000.zip',
    }
    ILM_DEFAULT_HOSTNAME: str = os.getenv('ILM_DEFAULT_HOSTNAME', 'lab')
    
    # Script Executor Configuration
    ILM_REGISTRY_URL: str = os.getenv('ILM_REGISTRY_URL', 'http://164.99.91.31:5100')
    DOCKER_INSTALL_PATH: str = 'dockerInstallScript/ubuntu/installDocker.sh'
    
    # Dependency rules for script generation
    ILM_DEPENDENCIES: List[str] = ['docker', 'docker-compose']
    
    # Network Configuration
    GATEWAY: str = os.getenv('GATEWAY', '10.71.39.254')
    DNS_SERVERS: List[str] = os.getenv('DNS_SERVERS', '15.122.222.53').split(',')
    # PRO
    # VM Creation Settings
    POWER_ON: bool = os.getenv('POWER_ON', 'true').lower() in ('true', '1', 'yes')
    SETUP_ILM: bool = False
    
    @classmethod
    def validate(cls) -> bool:
        """
        Validate that required configuration is present.
        
        Returns:
            bool: True if configuration is valid, False otherwise
        """
        missing = []
        
        if not cls.VCD_USERNAME:
            missing.append('VCD_USERNAME')
        if not cls.VCD_PASSWORD:
            missing.append('VCD_PASSWORD')
        
        if missing:
            print(f"[ERROR] Missing required configuration: {', '.join(missing)}")
            print(f"   Set them in .env file or as environment variables")
            return False
        
        return True
    
    @classmethod
    def summary(cls):
        """Print configuration summary (without sensitive data)."""
        print("=" * 60)
        print("Configuration Summary")
        print("=" * 60)
        print(f"VCD Host:          {cls.VCD_HOST}")
        print(f"Organization:      {cls.ORG_NAME}")
        print(f"Username:          {cls.VCD_USERNAME}")
        print(f"API Version:       {cls.API_VERSION}")
        print(f"VDC ID:            {cls.VDC_ID}")
        print(f"Template VM ID:    {cls.TEMPLATE_VM_ID}")
        print(f"Network:           {cls.NETWORK_NAME}")
        print(f"IP Allocation:     {cls.IP_ALLOCATION_MODE}")
        print(f"Gateway:           {cls.GATEWAY}")
        print(f"DNS Servers:       {', '.join(cls.DNS_SERVERS)}")
        print("=" * 60)


# Create a singleton instance
config = Config()


# Convenience function for quick validation
def ensure_config():
    """Ensure configuration is valid, exit if not."""
    if not config.validate():
        print("\n[TIP] Copy .env.example to .env and update with your credentials")
        exit(1)
