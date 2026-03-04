import requests
import urllib3
import base64

# Disable SSL warnings for internal labs (otxlab.net usually has self-signed certs)
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

class VCDAuthenticator:
    """
    Handles authentication to VMware Cloud Director.
    """
    
    def __init__(self, vcd_host, org_name, username, password, api_version="38.0"):
        """
        Initialize the authenticator with VCD connection details.
        
        Args:
            vcd_host: VCD server hostname (e.g., "ban-vcd.otxlab.net")
            org_name: Organization name
            username: User login name
            password: User password or API token
            api_version: VCD API version (default: "38.0")
        """
        self.vcd_host = vcd_host
        self.org_name = org_name
        self.username = username
        self.password = password
        self.api_version = api_version
        self.token = None
    
    def login(self):
        """
        Authenticates using the VCD 10.6+ CloudAPI endpoint.
        Legacy /api/sessions is deprecated/removed in this version.
        
        Returns:
            str: Authentication token (X-VMWARE-VCLOUD-ACCESS-TOKEN)
        """
        url = f"https://{self.vcd_host}/cloudapi/1.0.0/sessions"
        
        # For tenants, the user format MUST be: user@org
        # This acts as the "Tenant Context"
        user_with_org = f"{self.username}@{self.org_name}"
        
        print(f"Logging in as: {user_with_org}...")

        # Basic Auth is required for the initial session creation
        # We construct it manually to ensure exact encoding
        credentials = f"{user_with_org}:{self.password}"
        encoded_credentials = base64.b64encode(credentials.encode()).decode()

        headers = {
            "Accept": f"application/json;version={self.api_version}",
            "Authorization": f"Basic {encoded_credentials}"
        }

        try:
            response = requests.post(url, headers=headers, verify=False)
            response.raise_for_status()
            
            # In VCD 10.6, the token is in this specific header
            self.token = response.headers.get('X-VMWARE-VCLOUD-ACCESS-TOKEN')
            
            if not self.token:
                print("FAILED: Login worked but no X-VMWARE-VCLOUD-ACCESS-TOKEN found.")
                print("Headers returned:", response.headers)
                raise Exception("Token not found in response headers")
                
            print(f"   -> Success! Token acquired.")
            return self.token

        except requests.exceptions.HTTPError as e:
            print(f"   -> FAILED: {e}")
            print(f"   -> Server Reply: {response.text}") # type: ignore
            raise
    
    def get_token(self):
        """
        Returns the current token, logging in if necessary.
        
        Returns:
            str: Authentication token
        """
        if not self.token:
            self.login()
        return self.token


def get_vcd_token(vcd_host, org_name, username, password, api_version="38.0"):
    """
    Convenience function for simple authentication.
    
    Args:
        vcd_host: VCD server hostname
        org_name: Organization name
        username: User login name
        password: User password or API token
        api_version: VCD API version (default: "38.0")
    
    Returns:
        str: Authentication token
    """
    authenticator = VCDAuthenticator(vcd_host, org_name, username, password, api_version)
    return authenticator.login()
