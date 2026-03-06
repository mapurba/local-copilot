import contextvars
import json
import os
import re
import uuid
from typing import Annotated, Any, TypedDict
from pathlib import Path

import httpx
import requests
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool
from langchain_google_genai import ChatGoogleGenerativeAI
from langgraph.graph import END, StateGraph
from langgraph.graph.message import add_messages
from auth import VCDAuthenticator
from config import config as app_config
from vm_operations import VMOperations
from web.session_store import store
import logging
from langchain_core.callbacks import StdOutCallbackHandler # <--- Import this
logger = logging.getLogger(__name__)
# 1. Enable Debugging
from langchain_core.globals import set_debug
set_debug(True)

# 3. Create the Handler
handler = StdOutCallbackHandler()
# Inside your node:
logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler("debug_log.txt", mode='a'), # 'a' appends, 'w' overwrites
        logging.StreamHandler() # This keeps logs appearing in the console too
    ]
)

# Prevent Windows cp1252 console encoding crashes from verbose OpenAI debug payload logs.
logging.getLogger("openai._base_client").setLevel(logging.INFO)

# ── GitHub Copilot constants ──────────────────────────────────────────
_COPILOT_EDITOR_VERSION = os.environ.get("COPILOT_EDITOR_VERSION", "vscode/1.85.0")
_COPILOT_PLUGIN_VERSION = os.environ.get("COPILOT_PLUGIN_VERSION", "copilot-chat/0.12.0")
_COPILOT_INTEGRATION_ID = os.environ.get("COPILOT_INTEGRATION_ID", "vscode-chat")

_BASE_SYSTEM_PROMPT = (
    "You are a VMware Cloud Director assistant. Use tools for all data lookups. "
    "list_vms, list_running_vms, and list_stopped_vms only show VMs owned by the current user. "
    "To start a VM use start_vm with the vm_href. To stop a VM use stop_vm with the vm_href. "
    "\n\n"
    "When the user asks to create a VM, you MUST complete ALL of the following steps in a single "
    "turn WITHOUT asking any clarifying questions first:\n"
    "1. Immediately call list_templates (with a name_filter matching the OS the user mentioned, "
    "e.g. 'ubuntu' or 'sles') to find the best matching template.\n"
    "2. Pick the closest matching template from the results (match on OS name and version).\n"
    "3. Immediately call create_vm_draft with the vm_name, template_id, template_name, and any "
    "other parameters the user provided (e.g. setup_ilm, ilm_version) "
    "not specified — do NOT ask the user to supply missing optional fields.\n"
    "4. The draft form will be shown to the user automatically. Do NOT ask the user to confirm "
    "before calling create_vm_draft — the form itself is the review step.\n"
    "5. Only call create_vm_confirmed after the user explicitly confirms (e.g. clicks 'Run it' or "
    "says 'yes', 'confirm', 'proceed', 'create it').\n"
    "\n"
    "The customization script will automatically detect the OS (SLES, Ubuntu, RHEL, etc.) at "
    "runtime and apply the correct network configuration, so no manual OS selection is needed.\n"
    "\n"
    "NEVER ask the user questions such as 'Can you call list_templates?' or 'Please confirm you "
    "want to proceed' before showing the draft form. Act immediately with the information given.\n"
    "\n"
    "When asked to resize CPU or memory of a VM:\n"
    "1. Call resize_vm directly with the VM name (vm_name_or_href) and the desired num_cpus "
    "and/or memory_mb. You do NOT need to call list_vms first — the tool resolves the name "
    "to a href automatically.\n"
    "2. Both CPU and memory can be resized in a single resize_vm call.\n"
    "3. The tool handles power state automatically; inform the user a temporary power-off may occur.\n"
    "4. Confirm the new settings once the tool returns success.\n"
)

# Copilot-specific system prompt that includes JSON tool formatting instructions
_COPILOT_SYSTEM_PROMPT = _BASE_SYSTEM_PROMPT + (
    "\n\n"
    "TOOL CALLING FORMAT (Required for this system):\n"
    "When you need to use a tool, respond with BOTH:\n"
    "1. A brief description of what you're doing (natural language)\n"
    "2. A JSON block with the tool call using this EXACT format:\n"
    "\n"
    "```json\n"
    "{\n"
    '  "tool": "TOOL_NAME",\n'
    '  "args": {\n'
    '    "arg_name": "value"\n'
    '  }\n'
    "}\n"
    "```\n"
    "\n"
    "For example, if you need to list templates for ubuntu:\n"
    "\"Let me search for Ubuntu templates.\n"
    "{\n"
    '  "tool": "list_templates",\n'
    '  "args": {\n'
    '    "name_filter": "ubuntu"\n'
    '  }\n'
    "}\"\n"
    "\n"
    "Available tools: list_vms, list_running_vms, list_stopped_vms, start_vm, stop_vm, "
    "list_templates, create_vm_draft, create_vm_confirmed, resize_vm, delete_vm."
)

def _get_system_prompt(provider: str) -> str:
    """Return provider-specific system prompt."""
    if provider == "copilot":
        return _COPILOT_SYSTEM_PROMPT
    return _BASE_SYSTEM_PROMPT

SYSTEM_PROMPT = _get_system_prompt("copilot")  # Default for Copilot

_current_config: contextvars.ContextVar[RunnableConfig | None] = contextvars.ContextVar(
    "current_runnable_config", default=None
)


def _require_room_id() -> str:
    config = _current_config.get()
    room_id = (config or {}).get("configurable", {}).get("room_id")
    if not room_id:
        raise ValueError("Missing room_id in RunnableConfig")
    return room_id


def _get_room_context(room_id: str) -> dict:
    room = store.get_room(room_id)
    if not room:
        raise ValueError("Invalid room_id")
    return room


def _matches_owner(owner_name: str, username: str) -> bool:
    """VCD ownerName can be 'user', 'user@org', or 'org\\user' — match any format."""
    if not owner_name or not username:
        return False
    owner_lower = owner_name.lower()
    user_lower = username.lower()
    return (
        owner_lower == user_lower
        or owner_lower.startswith(user_lower + "@")
        or owner_lower.endswith("\\" + user_lower)
        or owner_lower.endswith("/" + user_lower)
    )


def _get_token_for_room(room_id: str) -> str:
    room = _get_room_context(room_id)
    token = room.get("token")
    if token:
        return token

    authenticator = VCDAuthenticator(
        vcd_host=app_config.VCD_HOST,
        org_name=room["org"],
        username=room["username"],
        password=room["password"],
        api_version=app_config.API_VERSION,
    )
    token = authenticator.login()
    store.set_token(room_id, token)
    return token


def _query_records(
    token: str,
    record_type: str,
    page_size: int = 128,
    extra_filter: str | None = None,
    sort_desc: str | None = None,
) -> list[dict]:
    url = f"https://{app_config.VCD_HOST}/api/query"
    headers = {
        "Accept": f"application/*+json;version={app_config.API_VERSION}",
        "Authorization": f"Bearer {token}",
    }
    params: dict = {"type": record_type, "format": "records", "pageSize": page_size}
    if extra_filter:
        params["filter"] = extra_filter
    if sort_desc:
        params["sortDesc"] = sort_desc
    response = requests.get(url, headers=headers, params=params, verify=False, timeout=30)
    response.raise_for_status()
    data = response.json()
    return data.get("record", [])


def _vm_status_summary(vm: dict) -> dict:
    status = str(vm.get("status", ""))
    name = vm.get("name", "Unknown")
    href = vm.get("href", "")
    is_on = status in {"4", "POWERED_ON", "poweredOn", "on"}
    return {
        "name": name,
        "status": status,
        "powered_on": is_on,
        "href": href,
        "ip": vm.get("ipAddress", vm.get("ip", "")),
        "owner": vm.get("ownerName", ""),
    }


@tool
def list_vms() -> dict:
    """List all VMs owned by the current user."""
    room_id = _require_room_id()
    token = _get_token_for_room(room_id)
    room = _get_room_context(room_id)
    username = room.get("username", "")
    vms = _query_records(
        token, "vm",
        extra_filter=f"ownerName==*{username}*;isVAppTemplate==false",
        sort_desc="dateCreated",
    )
    user_vms = [vm for vm in vms if _matches_owner(vm.get("ownerName", ""), username)]
    return {"count": len(user_vms), "vms": [_vm_status_summary(vm) for vm in user_vms]}


@tool
def list_templates(name_filter: str = "") -> dict:
    """List available vApp templates. Optionally pass name_filter (e.g. 'ubuntu') to search by name.
    Returns each template's name, id, catalog, status, CPU count, and memory so the LLM can pass
    the correct template_id when creating a VM."""
    print(f"[TOOL CALLED] list_templates with filter='{name_filter}'", flush=True)
    logger.info(f"[TOOL CALLED] list_templates with filter='{name_filter}'")
    
    room_id = _require_room_id()
    print(f"[DEBUG] room_id: {room_id}", flush=True)
    token = _get_token_for_room(room_id)
    print(f"[DEBUG] token obtained, querying templates...", flush=True)
    
    if name_filter.strip():
        flt = f"((isExpired==false);(name==*{name_filter.strip()}*))"
    else:
        flt = "((isExpired==false))"

    url = f"https://{app_config.VCD_HOST}/api/query"
    headers = {
        "Accept": f"application/*+json;version={app_config.API_VERSION}",
        "Authorization": f"Bearer {token}",
    }
    params = {
        "type": "vAppTemplate",
        "format": "records",
        "page": 1,
        "pageSize": 15,
        "filterEncoded": "true",
        "filter": flt,
        "sortAsc": "name",
        "links": "true",
    }
    response = requests.get(url, headers=headers, params=params, verify=False, timeout=30)
    response.raise_for_status()
    data = response.json()
    records = data.get("record", [])

    items = []
    for t in records:
        href = t.get("href", "")
        # href = ".../vAppTemplate/vappTemplate-<uuid>" — strip prefix so vm_operations gets plain UUID
        raw_id = href.split("/vAppTemplate/")[-1] if "/vAppTemplate/" in href else ""
        for prefix in ("vappTemplate-", "vm-"):
            if raw_id.startswith(prefix):
                raw_id = raw_id[len(prefix):]
                break
        other = t.get("otherAttributes", {}) or {}
        items.append({
            "name": t.get("name", ""),
            "template_id": raw_id,
            "catalog": t.get("catalogName", ""),
            "status": t.get("status", ""),
            "description": t.get("description", ""),
            "cpus": other.get("numberOfCpus", ""),
            "memory_mb": other.get("memoryAllocationMB", ""),
        })
    print(f"[DEBUG] Found {len(items)} templates", flush=True)
    return {"count": len(items), "total": data.get("total", len(items)), "templates": items}


@tool
def list_running_vms() -> dict:
    """List VMs owned by the current user that are powered on."""
    room_id = _require_room_id()
    token = _get_token_for_room(room_id)
    room = _get_room_context(room_id)
    username = room.get("username", "")
    vms = _query_records(
        token, "vm",
        extra_filter=f"ownerName==*{username}*;isVAppTemplate==false",
        sort_desc="dateCreated",
    )
    running = [
        vm for vm in vms
        if _matches_owner(vm.get("ownerName", ""), username)
        and str(vm.get("status", "")).lower() in {"4", "poweredon", "powered_on", "on"}
    ]
    return {"count": len(running), "vms": [_vm_status_summary(vm) for vm in running]}


@tool
def list_stopped_vms() -> dict:
    """List VMs owned by the current user that are powered off."""
    room_id = _require_room_id()
    token = _get_token_for_room(room_id)
    room = _get_room_context(room_id)
    username = room.get("username", "")
    vms = _query_records(
        token, "vm",
        extra_filter=f"ownerName==*{username}*;isVAppTemplate==false",
        sort_desc="dateCreated",
    )
    stopped = [
        vm for vm in vms
        if _matches_owner(vm.get("ownerName", ""), username)
        and str(vm.get("status", "")).lower() in {"8", "poweredoff", "powered_off", "off"}
    ]
    return {"count": len(stopped), "vms": [_vm_status_summary(vm) for vm in stopped]}


@tool
def check_vm_status(vm_name: str) -> dict:
    """Check if a VM is up by name."""
    room_id = _require_room_id()
    token = _get_token_for_room(room_id)
    vms = _query_records(token, "vm")
    for vm in vms:
        if vm.get("name") == vm_name:
            return {"found": True, "vm": _vm_status_summary(vm)}
    return {"found": False, "vm_name": vm_name}


@tool
def start_vm(vm_href: str) -> dict:
    """Power on a VM identified by its VCD href URL."""
    room_id = _require_room_id()
    token = _get_token_for_room(room_id)
    vm_ops = VMOperations(app_config.VCD_HOST, token, api_version=app_config.API_VERSION)
    return vm_ops.power_on_vm(vm_href)


@tool
def stop_vm(vm_href: str) -> dict:
    """Power off a VM identified by its VCD href URL."""
    room_id = _require_room_id()
    token = _get_token_for_room(room_id)
    vm_ops = VMOperations(app_config.VCD_HOST, token, api_version=app_config.API_VERSION)
    return vm_ops.power_off_vm(vm_href)


def _resolve_vm_href_by_name(token: str, username: str, name_or_href: str) -> str:
    """Return a VM href given either a full href URL or a VM name.

    If *name_or_href* starts with 'http' it is returned as-is. Otherwise the
    user's VM list is searched for an exact case-insensitive name match.
    Raises ValueError when no match is found or when more than one VM shares
    the same name (to avoid acting on the wrong VM).
    """
    if name_or_href.startswith("http"):
        return name_or_href
    vms = _query_records(
        token, "vm",
        extra_filter=f"ownerName==*{username}*;isVAppTemplate==false",
        sort_desc="dateCreated",
    )
    needle = name_or_href.lower()
    matches = [
        vm for vm in vms
        if vm.get("name", "").lower() == needle and _matches_owner(vm.get("ownerName", ""), username)
    ]
    if len(matches) == 0:
        raise ValueError(f"No VM named '{name_or_href}' found for the current user.")
    if len(matches) > 1:
        hrefs = [vm.get("href", "?") for vm in matches]
        raise ValueError(
            f"Ambiguous: {len(matches)} VMs are named '{name_or_href}'. "
            f"Please supply the exact vm_href instead. Found hrefs: {hrefs}"
        )
    href = matches[0].get("href", "")
    if not href:
        raise ValueError(f"VM '{name_or_href}' was found but has no href.")
    return href


@tool
def resize_vm(
    vm_name_or_href: str,
    num_cpus: int | None = None,
    memory_mb: int | None = None,
) -> dict:
    """Resize the CPU and/or RAM of a VM.

    Pass the VM name (e.g. 'myvm') or its full VCD href. At least one of
    num_cpus or memory_mb must be provided. Both can be set in a single call.

    Limits: max 4 vCPUs, max 20480 MB (20 GB) RAM.
    If the VM is powered on it will be automatically shut down first.

    Args:
        vm_name_or_href: VM name as shown in list_vms, or its full VCD href URL.
        num_cpus: Desired number of virtual CPUs (1–4), or omit to leave unchanged.
        memory_mb: Desired RAM in MB (512–20480, e.g. 8192 = 8 GB), or omit to leave unchanged.
    """
    if not num_cpus and not memory_mb:
        return {"status": "error", "message": "Provide at least one of num_cpus or memory_mb."}
    room_id = _require_room_id()
    token = _get_token_for_room(room_id)
    room = _get_room_context(room_id)
    username = room.get("username", "")
    vm_href = _resolve_vm_href_by_name(token, username, vm_name_or_href)
    vm_ops = VMOperations(app_config.VCD_HOST, token, api_version=app_config.API_VERSION)
    return vm_ops.update_vm_resources(vm_href, cpu_count=num_cpus, ram_mb=memory_mb)


@tool
def create_vm_draft(
    vm_name: str,
    template_id: str | None = None,
    template_name: str | None = None,
    network_name: str | None = None,
    ip_allocation_mode: str | None = None,
    ip_address: str | None = None,
    gateway: str | None = None,
    dns_servers: str | None = None,
    power_on: bool | None = None,
    storage_profile_id: str | None = None,
    compute_policy_id: str | None = None,
    setup_ilm: bool | None = None,
    ilm_version: str | None = None,
) -> dict:
    """Prepare a VM creation form for human review before creating the VM.

    IMPORTANT: Always pass template_name from the list_templates result alongside template_id.
    template_name is used to automatically select the correct OS customization script:
    - SLES 15 templates (e.g. SLES_15_SP5, SLES_15_SP6, SLES_15_SP7) → sysconfig/wicked network config
    - All other templates (Ubuntu, RHEL, etc.) → Netplan network config
    Omitting template_name will cause SLES VMs to receive the wrong network configuration.
    """
    room_id = _require_room_id()
    room = _get_room_context(room_id)
    org = room.get("org", "")

    form = {
        "vm_name": vm_name,
        "template_id": template_id or app_config.TEMPLATE_VM_ID,
        "template_name": template_name or "",
        "network_name": network_name or app_config.NETWORK_NAME,
        "ip_allocation_mode": ip_allocation_mode or app_config.IP_ALLOCATION_MODE,
        "ip_address": ip_address or "",
        "gateway": gateway or app_config.GATEWAY,
        "dns_servers": dns_servers or ",".join(app_config.DNS_SERVERS),
        "power_on": power_on if power_on is not None else app_config.POWER_ON,
        # Resolve per-org defaults; LLM-supplied values take precedence if provided
        "storage_profile_id": storage_profile_id or app_config.STORAGE_PROFILE_ID_MAP.get(org, app_config.STORAGE_PROFILE_ID),
        "compute_policy_id": compute_policy_id or app_config.COMPUTE_POLICY_ID_MAP.get(org, app_config.COMPUTE_POLICY_ID),
        "org": org,
        "setup_ilm": setup_ilm or app_config.SETUP_ILM,
        "ilm_version": ilm_version or "latest",
    }

    store.set_pending_form(room_id, form)

    print(f"[DEBUG] Created VM draft form for room {room_id}: {json.dumps(form)}")
    return {
        "type": "vm_create_form",
        "message": "Review the VM details and click Run it to create the VM.",
        "form": form,
    }


@tool
def create_vm_confirmed() -> dict:
    """Create the VM using the last confirmed form in this chat room."""
    room_id = _require_room_id()
    room = _get_room_context(room_id)
    form = store.get_pending_form(room_id)
    if not form:
        return {"status": "error", "message": "No pending VM form found."}

    token = _get_token_for_room(room_id)
    vm_ops = VMOperations(app_config.VCD_HOST, token, api_version=app_config.API_VERSION)

    vdc_id = app_config.VDC_ID_MAP.get(room.get("org", ""), app_config.VDC_ID)
    storage_profile_id = app_config.STORAGE_PROFILE_ID_MAP.get(room.get("org", ""), app_config.STORAGE_PROFILE_ID)
    compute_policy_id = app_config.COMPUTE_POLICY_ID_MAP.get(room.get("org", ""), app_config.COMPUTE_POLICY_ID)
    org_name = room.get("org", "")
    org_uuid = app_config.ORG_UUID_MAP.get(org_name, "")

    # Validate storage profile and compute policy against live VCD before deploying
    validation = vm_ops._validate_resource_ids(vdc_id, storage_profile_id, compute_policy_id,
                                               org_name=org_name, org_uuid=org_uuid)
    # if not validation["valid"]:
    #     hint = ""
    #     if "storage_profiles" in validation.get("available", {}):
    #         hint += " Available storage profiles: " + str(validation["available"]["storage_profiles"])
    #     if "compute_policies" in validation.get("available", {}):
    #         hint += " Available compute policies: " + str(validation["available"]["compute_policies"])
    #     return {
    #         "status": "error",
    #         "message": "Resource ID validation failed — the configured storage profile or compute policy "
    #                    "may be outdated for this org. Please update config.py maps.\n"
    #                    + "\n".join(validation["errors"]) + hint,
    #     }

    result = vm_ops.create_vm_from_template(
        vdc_id=vdc_id,
        template_vm_id=form["template_id"],
        template_name=form.get("template_name", ""),
        org_name=org_name,
        org_uuid=org_uuid,
        vm_name=form["vm_name"],
        network_name=form["network_name"],
        ip_address=form["ip_address"],
        gateway=form["gateway"],
        dns_servers=form["dns_servers"].split(","),
        power_on=form["power_on"],
        ip_allocation_mode="DHCP",  # Force DHCP for simplicity in this example
        network_adapter_type=app_config.NETWORK_ADAPTER_TYPE,
        storage_profile_id=storage_profile_id,
        compute_policy_id=compute_policy_id,
        setup_ilm=form.get("setup_ilm", False),
        ilm_version=form.get("ilm_version", "latest"),
    )

    store.set_pending_form(room_id, None)
    return {"status": "success", "result": result}


@tool
def list_tasks(minutes_ago: int = 60, page_size: int = 50) -> dict:
    """List recent VCD tasks from the last N minutes (default 60).
    Useful for checking the status of recent VM deployments, power operations, or any async VCD operation.
    Pass minutes_ago=1440 to look back 24 hours, or minutes_ago=10 for only the last 10 minutes."""
    from datetime import datetime, timezone, timedelta
    room_id = _require_room_id()
    token = _get_token_for_room(room_id)

    since = datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)
    # VCD FIQL operator: startDate=gt=<ISO8601 without microseconds>
    since_str = since.strftime("%Y-%m-%dT%H:%M:%S.00")

    url = f"https://{app_config.VCD_HOST}/api/query"
    headers = {
        "Accept": f"application/*+json;version={app_config.API_VERSION}",
        "Authorization": f"Bearer {token}",
    }
    params = {
        "type": "task",
        "format": "records",
        "page": 1,
        "pageSize": page_size,
        "filterEncoded": "true",
        "filter": f"startDate=gt={since_str}",
    }
    response = requests.get(url, headers=headers, params=params, verify=False, timeout=30)
    response.raise_for_status()
    data = response.json()
    records = data.get("record", [])

    items = []
    for t in records:
        items.append({
            "name": t.get("name", ""),
            "status": t.get("status", ""),
            "object": t.get("objectName", ""),
            "object_type": t.get("objectType", ""),
            "owner": t.get("ownerName", ""),
            "start": t.get("startDate", ""),
            "end": t.get("endDate", ""),
            "progress": t.get("progress", ""),
            "details": t.get("details", ""),
        })
    return {"count": len(items), "total": data.get("total", len(items)), "since_minutes_ago": minutes_ago, "tasks": items}


TOOLS = [
    list_vms,
    list_templates,
    list_running_vms,
    list_stopped_vms,
    check_vm_status,
    start_vm,
    stop_vm,
    resize_vm,
    create_vm_draft,
    create_vm_confirmed,
    list_tasks,
]


class AgentState(TypedDict):
    messages: Annotated[list, add_messages]


class ChatAgent:
    def __init__(self) -> None:
        from pathlib import Path
        import json
        logger.info("[ChatAgent] Initializing...")
        # Load config from llm_config.json
        config_path = Path(__file__).parent.parent / 'llm_config_dev' / 'llm_config.json'
        if not config_path.exists():
            # fallback for packaged
            config_path = Path.home() / 'AppData' / 'Roaming' / 'VCD-Agent' / 'llm_config.json'
        if config_path.exists():
            with open(config_path, 'r', encoding='utf-8') as f:
                cfg = json.load(f)
        else:
            cfg = {"provider": "copilot", "model": "llama3.2:3b", "credentials": {}}

        def _load_copilot_token_from_apps_json() -> str:
            """Load first oauth_token found in apps.json.
            Matches local-copilot implementation: just find any entry with oauth_token.
            Returns empty string if not found.
            """
            local_app_data = os.environ.get("LOCALAPPDATA")
            if not local_app_data:
                local_app_data = str(Path.home() / "AppData" / "Local")
            apps_path = Path(local_app_data) / "github-copilot" / "apps.json"
            try:
                with open(apps_path, "r", encoding="utf-8") as apps_file:
                    apps = json.load(apps_file)
                # Look for any app entry with an oauth_token (matching local-copilot logic)
                for entry in apps.values():
                    token = entry.get("oauth_token") if isinstance(entry, dict) else None
                    if token:
                        logger.info(f"[_load_copilot_token] Found oauth_token in apps.json")
                        return str(token)
            except Exception as e:
                logger.warning(f"[_load_copilot_token] Failed to read apps.json: {e}")
            return ""

        provider = cfg.get("provider", "copilot")
        model = cfg.get("model", "llama3.2:3b")
        credentials = cfg.get("credentials", {})
        if provider == "copilot" and not credentials.get("github_token"):
            token = _load_copilot_token_from_apps_json()
            if token:
                credentials = {**credentials, "github_token": token}
        temperature = float(os.getenv("MODEL_TEMPERATURE", "0.2"))
        self._llm_timeout_seconds = float(os.getenv("LLM_INVOKE_TIMEOUT_SECONDS", "300"))
        self._provider = provider
        self._model_name = model
        self._temperature = temperature
        # Copilot-specific state (initialized for all providers to avoid AttributeError)
        self._github_token: str = ""
        self._copilot_session_token: str | None = None
        self._copilot_token_expires: float = 0.0
        self._active_copilot_model: str | None = None
        print(f"[DEBUG] [ChatAgent.__init__] Loaded from config: provider={provider}, model={model}", flush=True)
        logger.info(f"[ChatAgent] Configured from llm_config.json: provider={provider}, model={model}")

        if provider == "bedrock":
            try:
                from langchain_aws import ChatBedrock
            except ImportError as exc:
                raise RuntimeError("langchain-aws is not installed") from exc
            model_id = model or "anthropic.claude-3-5-sonnet-20240620-v1:0"
            import boto3
            region = credentials.get("aws_region", "us-east-1")
            aws_access_key = credentials.get("aws_access_key")
            aws_secret_key = credentials.get("aws_secret_key")
            bedrock_client = boto3.client(
                "bedrock-runtime",
                region_name=region,
                aws_access_key_id=aws_access_key,
                aws_secret_access_key=aws_secret_key
            )
            self._llm = ChatBedrock(
                model=model_id,
                client=bedrock_client,
                model_kwargs={"temperature": temperature},
            ).bind_tools(TOOLS)
        elif provider == "ollama":
            try:
                from langchain_ollama import ChatOllama
            except ImportError as exc:
                raise RuntimeError("langchain-ollama is not installed") from exc
            model_name = model or "qwen3"
            base_url = "http://localhost:11434"
            self._llm = ChatOllama(
                model=model_name,
                base_url=base_url,
                temperature=temperature,
            ).bind_tools(TOOLS)
        elif provider == "openai":
            try:
                from langchain_openai import ChatOpenAI
            except ImportError as exc:
                raise RuntimeError("langchain-openai is not installed") from exc
            api_key = credentials.get("openai_api_key")
            model_name = model or "gpt-4o"  # gpt-4 no longer supported; use gpt-4o
            self._llm = ChatOpenAI(
                model=model_name,
                api_key=api_key,
                temperature=temperature,
            ).bind_tools(TOOLS)
        elif provider == "gemini":
            try:
                from langchain_google_genai import ChatGoogleGenerativeAI
            except ImportError as exc:
                raise RuntimeError("langchain-google-genai is not installed") from exc
            api_key = credentials.get("gemini_api_key")
            model_name = model or "gemini-1.5-flash-latest"
            self._llm = ChatGoogleGenerativeAI(
                model=model_name,
                temperature=temperature,
                google_api_key=api_key,
            ).bind_tools(TOOLS)
        elif provider == "copilot":
            github_token = credentials.get("github_token")
            if not github_token:
                raise RuntimeError(
                    "GitHub token not found in llm_config.json or apps.json.\n\n"
                    "To use GitHub Copilot:\n"
                    "1. Install the official GitHub Copilot extension in VS Code\n"
                    "2. Sign in with your GitHub account (must have active Copilot subscription)\n"
                    "3. Restart this application - it will auto-detect the token from apps.json\n\n"
                    "Or select a different LLM provider from the startup screen."
                )
            try:
                from langchain_openai import ChatOpenAI as _CopilotChatOpenAI  # noqa: F401
            except ImportError as exc:
                raise RuntimeError("langchain-openai is not installed") from exc
            self._github_token = github_token
            # Defer session token fetch until the first chat request.
            self._llm = None
        else:
            raise RuntimeError(f"Unrecognized LLM provider: {provider}")

        self._graph = self._build_graph()

    # ── Copilot helpers ──────────────────────────────────────────────────

    def _build_copilot_llm(self, override_model: str | None = None):
        """Build ChatOpenAI client using Copilot oauth token.
        
        The oauth_token (ghu_*) from apps.json is used directly as a Bearer token
        with api.githubcopilot.com. This matches how the official Copilot extension works.
        Matches local-copilot implementation.
        
        NOTE: Copilot sometimes returns `finish_reason: "tool_calls"` with empty `tool_calls`.
        We use bind_tools() for structured tool calling when it works, and fall back to
        text extraction when the API doesn't return proper tool_calls.
        """
        from langchain_openai import ChatOpenAI

        # The oauth_token can be used directly as a Bearer token with api.githubcopilot.com
        # No session token exchange needed - the ghu_* token is the actual Copilot token
        if not self._github_token:
            raise RuntimeError(
                "GitHub Copilot token not configured. Please ensure the official "
                "GitHub Copilot extension is installed and authenticated in VS Code."
            )

        logger.info(f"[Copilot] _build_copilot_llm called with override_model={override_model}, self._model_name={self._model_name}")
        model_name = override_model or self._resolve_copilot_model(self._model_name)
        self._active_copilot_model = model_name
        logger.info(f"[Copilot] ✓ Resolved model name: {model_name}")
        logger.info(f"[Copilot] Using model for chat/completions: {model_name}")
        print(f"[DEBUG] [Copilot] Building LLM with model: {model_name}", flush=True)
        llm = ChatOpenAI(
            model=model_name,
            api_key=self._github_token,
            base_url="https://api.githubcopilot.com",
            default_headers={
                "Copilot-Integration-Id": _COPILOT_INTEGRATION_ID,
                "Editor-Version": _COPILOT_EDITOR_VERSION,
                "Editor-Plugin-Version": _COPILOT_PLUGIN_VERSION,
                "User-Agent": "GitHubCopilot/1.1.0",
                "X-GitHub-Api-Version": "2023-07-07",
            },
            temperature=self._temperature,
        )
        # Use bind_tools() to enable structured tool calling when the API supports it.
        # Falls back to text extraction if API doesn't return proper tool_calls.
        return llm.bind_tools(TOOLS)

    def _is_copilot_forbidden_error(self, err: Exception) -> bool:
        message_text = str(err).lower()
        return (
            "forbidden" in message_text
            or "permissiondeniederror" in message_text
            or "access to this endpoint is forbidden" in message_text
        )

    def _get_copilot_candidate_models(self, failed_model: str | None) -> list[str]:
        """Get list of available Copilot models to try, in priority order."""
        candidates: list[str] = []

        if failed_model:
            candidates.append(failed_model)

        try:
            headers = {
                "Authorization": f"Bearer {self._github_token}",
                "Content-Type": "application/json",
                "Editor-Version": _COPILOT_EDITOR_VERSION,
                "Editor-Plugin-Version": _COPILOT_PLUGIN_VERSION,
                "Copilot-Integration-Id": _COPILOT_INTEGRATION_ID,
                "User-Agent": "GitHubCopilot/1.1.0",
                "X-GitHub-Api-Version": "2023-07-07",
            }
            resp = requests.get("https://api.githubcopilot.com/models", headers=headers, timeout=10)
            resp.raise_for_status()
            payload = resp.json() or {}
            data = payload.get("data", [])
            discovered = [
                item.get("id") for item in data
                if isinstance(item, dict) and isinstance(item.get("id"), str)
            ]
            logger.info(f"[Copilot] Discovered available models: {discovered}")
            candidates.extend(discovered)
        except Exception as e:
            logger.warning(f"[Copilot] Failed to fetch model list: {e}")

        # Remove duplicates while preserving order
        unique: list[str] = []
        for model in candidates:
            if model and model not in unique:
                unique.append(model)
        return unique

    def _resolve_copilot_model(self, requested_model: str | None) -> str:
        """Resolve a valid Copilot model for /chat/completions.

        - Uses the requested model when it's available from /models.
        - Prioritizes gpt-4.1 as the default choice.
        - Falls back to the first available model from your subscription.
        - Only uses models that are actually available (no hardcoded fallbacks).
        """
        requested = (requested_model or "").strip()
        priority_model = "gpt-4.1"  # First priority

        headers = {
            "Authorization": f"Bearer {self._github_token}",
            "Content-Type": "application/json",
            "Editor-Version": _COPILOT_EDITOR_VERSION,
            "Editor-Plugin-Version": _COPILOT_PLUGIN_VERSION,
            "Copilot-Integration-Id": _COPILOT_INTEGRATION_ID,
            "User-Agent": "VCD-Agent/1.0.0",
            "X-GitHub-Api-Version": "2023-07-07",
        }

        try:
            logger.info(f"[Copilot] Querying /models endpoint to find available models...")
            resp = requests.get(
                "https://api.githubcopilot.com/models",
                headers=headers,
                timeout=10,
            )
            resp.raise_for_status()
            payload = resp.json() or {}
            data = payload.get("data", [])
            available_models = [
                item.get("id") for item in data
                if isinstance(item, dict) and isinstance(item.get("id"), str)
            ]

            logger.info(f"[Copilot] Available models from API: {available_models}")
            print(f"[DEBUG] [Copilot] Available models: {available_models}", flush=True)

            # If user requested a specific model, try to use it first
            if requested and requested in available_models:
                logger.info(f"[Copilot] ✓ Using requested model: {requested}")
                print(f"[DEBUG] [Copilot] Using requested model: {requested}", flush=True)
                return requested

            # Try priority model (gpt-4.1)
            if priority_model in available_models:
                logger.info(f"[Copilot] ✓ Using priority model: {priority_model}")
                print(f"[DEBUG] [Copilot] Using priority model: {priority_model}", flush=True)
                return priority_model

            # Otherwise, use the first available model
            if available_models:
                chosen = available_models[0]
                logger.warning(
                    f"[Copilot] Priority model '{priority_model}' not available. "
                    f"Available models: {available_models}. Using '{chosen}'."
                )
                print(f"[DEBUG] [Copilot] Using fallback model: {chosen}", flush=True)
                return chosen

            # Should not reach here if token is valid
            logger.error("[Copilot] No models available from API - token may be invalid or subscription expired")
            raise RuntimeError("No Copilot models available - check your subscription")

        except requests.exceptions.RequestException as e:
            logger.error(f"[Copilot] Failed to fetch available models: {e}")
            logger.error(f"[Copilot] Requested model was: {requested or 'none'}")
            
            # FALLBACK: If API query fails, try known good default models in order
            logger.warning("[Copilot] Using fallback model selection (API query failed)")
            fallback_defaults = ["gpt-4.1", "gpt-4o", "gpt-5 mini"]
            for model in fallback_defaults:
                logger.info(f"[Copilot] Trying fallback default: {model}")
            
            # Use the first fallback, but log that we're guessing
            logger.warning(f"[Copilot] WARNING: Using unverified fallback model {fallback_defaults[0]}")
            print(f"[DEBUG] [Copilot] Using unverified fallback: {fallback_defaults[0]}", flush=True)
            return fallback_defaults[0]

    def _get_llm(self):
        """Return the current LLM instance."""
        if self._provider == "copilot" and not self._llm:
            # Lazy-init Copilot LLM on first use
            self._llm = self._build_copilot_llm()
        return self._llm

    def _extract_copilot_tool_calls_from_text(self, text: str) -> list[dict]:
        """Extract tool calls from Copilot's text response.
        
        Since Copilot API doesn't support structured tool_calls, we parse the response
        text for patterns that indicate tool usage based on the system prompt.
        
        Returns list of tool calls in LangChain format:
        [
            {
                "id": "call_xxx",
                "name": "tool_name",
                "args": {"arg_name": "value"}
            }
        ]
        """
        tool_calls = []
        tool_names = [tool.name for tool in TOOLS]
        
        logger.info(f"[Copilot] Extracting tool calls from response text ({len(text)} chars)")
        
        # Try to find JSON-formatted tool calls in the response
        import re as regex
        json_pattern = r'\{[^{}]*"(?:tool|name)"[^{}]*\}'
        for match in regex.finditer(json_pattern, text):
            try:
                tool_obj = json.loads(match.group())
                tool_name = tool_obj.get("tool") or tool_obj.get("name")
                if tool_name in tool_names:
                    tool_id = str(uuid.uuid4())
                    tool_calls.append({
                        "id": tool_id,
                        "name": tool_name,
                        "args": tool_obj.get("args", {})
                    })
                    logger.info(f"[Copilot] Extracted tool call from JSON: {tool_name}")
                    print(f"[DEBUG] Extracted JSON tool call: {tool_name}", flush=True)
            except (json.JSONDecodeError, AttributeError) as e:
                logger.debug(f"[Copilot] JSON parse failed: {e}")
                continue
        
        # Pattern-based extraction for natural language tool mentions
        for tool in TOOLS:
            # Look for phrases like "I'll call list_templates", "Calling `list_templates`", "using list_templates", etc.
            patterns = [
                rf"(?:call|use|invoke|execute|calling|utilizing)\s+[`\"]?{tool.name}[`\"]?",
                rf"{tool.name}\s*\(",
                rf"(?:tool|function)[`\"]?\s*[=:]\s*[`\"]?{tool.name}",
            ]
            for pattern in patterns:
                if regex.search(pattern, text, regex.IGNORECASE):
                    # Don't add duplicate if already extracted
                    if not any(call["name"] == tool.name for call in tool_calls):
                        # Try to extract args from context
                        args = {}
                        if tool.name == "list_templates":
                            # Look for name_filter in the text
                            filter_match = regex.search(
                                r'(?:name_filter|filter|OS|os)\s*[=:]\s*["`]?([^"`\s,\)]+)',
                                text, regex.IGNORECASE
                            )
                            if filter_match:
                                args["name_filter"] = filter_match.group(1)
                        elif tool.name == "create_vm_draft":
                            # Look for vm_name
                            name_match = regex.search(
                                r'(?:vm_name|name)[`\"]?\s*[=:]\s*["`]?([^"`\s,\)]+)',
                                text, regex.IGNORECASE
                            )
                            if name_match:
                                args["vm_name"] = name_match.group(1)
                        
                        tool_id = str(uuid.uuid4())
                        tool_calls.append({
                            "id": tool_id,
                            "name": tool.name,
                            "args": args
                        })
                        logger.info(f"[Copilot] Extracted tool call from pattern: {tool.name} with args {args}")
                        print(f"[DEBUG] Extracted pattern tool call: {tool.name} with args {args}", flush=True)
                    break
        
        if tool_calls:
            logger.info(f"[Copilot] Total tool calls extracted: {len(tool_calls)}")
        else:
            logger.debug(f"[Copilot] No tool calls found in response text")
        
        return tool_calls

    def _build_tool_fallback_message(self, messages: list) -> str:
        """Build a deterministic assistant response from the latest ToolMessage.

        Used when Copilot blocks the post-tool follow-up completion.
        """
        last_tool: ToolMessage | None = None
        for message in reversed(messages):
            if isinstance(message, ToolMessage):
                last_tool = message
                break

        if not last_tool:
            return "I completed the tool call, but failed to generate the final response."

        raw = last_tool.content if isinstance(last_tool.content, str) else json.dumps(last_tool.content)
        try:
            data = json.loads(raw)
        except Exception:
            data = None

        if isinstance(data, dict) and isinstance(data.get("templates"), list):
            templates = data.get("templates", [])
            if not templates:
                return "No matching templates were found."
            lines = ["Here are the matching templates:"]
            for template in templates:
                if not isinstance(template, dict):
                    continue
                name = template.get("name", "")
                template_id = template.get("template_id", "")
                catalog = template.get("catalog", "")
                lines.append(f"- {name} (id: {template_id}, catalog: {catalog})")
            return "\n".join(lines)

        if isinstance(data, dict) and "count" in data:
            return f"Tool result: {json.dumps(data)}"

        return raw[:4000]

    def _build_graph(self):
        # ContextVar-injecting ToolNode: sets room_id config before each tool call
        def _tools_node(state: AgentState, config: RunnableConfig) -> AgentState:
            import sys
            print("[DEBUG] Entered _tools_node", flush=True)
            last = state["messages"][-1]
            tool_calls = getattr(last, "tool_calls", [])
            logger.info(f"[TOOLS_NODE] tool_calls found: {len(tool_calls)}")
            print(f"[DEBUG] tool_calls found: {len(tool_calls)}", flush=True)
            for call in tool_calls:
                logger.info(f"[TOOLS_NODE] Calling tool: {call['name']} with args: {call.get('args', {})}")
                print(f"[DEBUG] Calling tool: {call['name']} with args: {call.get('args', {})}", flush=True)
            tool_map = {t.name: t for t in TOOLS}
            results = []
            for call in tool_calls:
                tool_fn = tool_map[call["name"]]
                cv_token = _current_config.set(config)
                try:
                    print(f"[DEBUG] Invoking tool: {call['name']}", flush=True)
                    result = tool_fn.invoke(call["args"], config={"callbacks": [handler]})
                    print(f"[DEBUG] Tool result: {result}", flush=True)
                except Exception as e:
                    logger.error(f"[TOOLS_NODE] Exception in tool {call['name']}: {str(e)}", exc_info=True)
                    print(f"[ERROR] Exception in tool {call['name']}: {str(e)}", flush=True)
                    result = {"error": str(e)}
                finally:
                    _current_config.reset(cv_token)
                content = result if isinstance(result, str) else json.dumps(result)
                results.append(ToolMessage(content=content, tool_call_id=call["id"]))
            print("[DEBUG] Exiting _tools_node", flush=True)
            return {"messages": results}

        def _chatbot(state: AgentState, config: RunnableConfig) -> AgentState:
            print("[DEBUG] Entered _chatbot", flush=True)
            logger.info(f"[CHATBOT] Invoking {self._provider} LLM with {len(state['messages'])} messages")
            import sys; sys.stdout.flush()
            for i, msg in enumerate(state['messages']):
                logger.info(f"[CHATBOT]   Message {i}: {type(msg).__name__}")
            print(f"[DEBUG] Messages to LLM: {[type(msg).__name__ for msg in state['messages']]}", flush=True)
            sys.stdout.flush()
            try:
                # Add timeout for LLM call
                import threading
                result: dict[str, Any] = {"value": None}
                exception: dict[str, Exception | None] = {"value": None}
                
                def invoke_llm():
                    try:
                        result["value"] = self._get_llm().invoke(state["messages"], config={"callbacks": [handler]})
                    except Exception as e:
                        exception["value"] = e
                
                thread = threading.Thread(target=invoke_llm, daemon=True)
                thread.start()
                timeout_seconds = self._llm_timeout_seconds if self._llm_timeout_seconds > 0 else None
                thread.join(timeout=timeout_seconds)
                
                if thread.is_alive():
                    logger.error(f"[CHATBOT] LLM invocation timed out after {self._llm_timeout_seconds} seconds")
                    raise TimeoutError("LLM invocation timed out")
                
                if exception["value"]:
                    if self._provider == "copilot" and self._is_copilot_forbidden_error(exception["value"]):
                        failed_model = self._active_copilot_model or self._model_name
                        model_candidates = self._get_copilot_candidate_models(failed_model)
                        retried = False

                        for candidate in model_candidates:
                            if candidate == failed_model:
                                continue
                            logger.warning(
                                f"[Copilot] Model '{failed_model}' forbidden; retrying with '{candidate}'."
                            )
                            try:
                                self._llm = self._build_copilot_llm(override_model=candidate)
                                retried = True
                                result["value"] = self._get_llm().invoke(
                                    state["messages"],
                                    config={"callbacks": [handler]},
                                )
                                exception["value"] = None
                                break
                            except Exception as retry_err:
                                if not self._is_copilot_forbidden_error(retry_err):
                                    exception["value"] = retry_err
                                    break
                                exception["value"] = retry_err
                                continue

                        if retried and exception["value"] is None:
                            response = result["value"]
                        else:
                            raise exception["value"]
                    else:
                        raise exception["value"]
                    
                response = result["value"]
                if response is None:
                    raise RuntimeError("LLM invocation returned no response")
            except Exception as e:
                logger.error(f"[CHATBOT] LLM invocation failed: {str(e)}", exc_info=True)
                if isinstance(e, RuntimeError) and "Copilot access denied" in str(e):
                    return {
                        "messages": [
                            AIMessage(content=str(e))
                        ]
                    }
                if self._provider == "copilot":
                    message_text = str(e).lower()
                    has_tool_result = any(isinstance(m, ToolMessage) for m in state["messages"])
                    if has_tool_result and (
                        "forbidden" in message_text
                        or "permissiondeniederror" in message_text
                        or "access to this endpoint is forbidden" in message_text
                    ):
                        logger.warning(
                            "[CHATBOT] Copilot blocked post-tool completion; returning fallback response from tool output."
                        )
                        fallback = self._build_tool_fallback_message(state["messages"])
                        return {"messages": [AIMessage(content=fallback)]}
                if isinstance(e, TimeoutError):
                    return {
                        "messages": [
                            AIMessage(
                                content=(
                                    "The model is taking longer than expected to respond. "
                                    "Please try again, or increase LLM_INVOKE_TIMEOUT_SECONDS "
                                    "in your environment."
                                )
                            )
                        ]
                    }
                sys.stdout.flush()
                raise
            
            logger.info(f"[CHATBOT] LLM response type: {type(response).__name__}")
            print(f"[DEBUG] LLM response type: {type(response).__name__}", flush=True)
            if hasattr(response, 'tool_calls'):
                print(f"[DEBUG] Tool calls from LLM: {getattr(response, 'tool_calls', None)}", flush=True)
            sys.stdout.flush()
            
            # For Copilot, extract tool calls from text response since the API doesn't support structured tool_calls
            if self._provider == "copilot" and isinstance(response, AIMessage):
                print(f"[DEBUG] Copilot provider detected, attempting tool call extraction...", flush=True)
                logger.info("[Copilot] Extracting tool calls from Copilot text response...")
                response_text = response.content
                if isinstance(response_text, list):
                    # Convert list of content blocks to string
                    response_text = " ".join(str(item) for item in response_text if item)
                else:
                    response_text = response_text or ""
                
                print(f"[DEBUG] Response text length: {len(response_text)}, first 100 chars: {response_text[:100]}", flush=True)
                extracted_tool_calls = self._extract_copilot_tool_calls_from_text(response_text)
                if extracted_tool_calls:
                    logger.info(f"[Copilot] ✓ Extracted {len(extracted_tool_calls)} tool calls from text response")
                    print(f"[DEBUG] ✓ Copilot tool calls extracted: {len(extracted_tool_calls)}", flush=True)
                    # Create a new AIMessage with the extracted tool_calls
                    response = AIMessage(
                        content=response.content,
                        tool_calls=extracted_tool_calls,
                    )
                    print(f"[DEBUG] ✓ Response updated with {len(extracted_tool_calls)} tool_calls", flush=True)
                else:
                    print(f"[DEBUG] ✗ No tool calls extracted from Copilot response", flush=True)
                    logger.debug("[Copilot] No tool calls found in response text")
            
            return {"messages": [response]}

        def _should_continue(state: AgentState) -> str:
            last = state["messages"][-1]
            return "tools" if getattr(last, "tool_calls", None) else END

        graph = StateGraph(AgentState)
        graph.add_node("chatbot", _chatbot)
        graph.add_node("tools", _tools_node)
        graph.set_entry_point("chatbot")
        graph.add_conditional_edges("chatbot", _should_continue, {"tools": "tools", END: END})
        graph.add_edge("tools", "chatbot")
        return graph.compile()

    def handle_message(self, room_id: str, text: str) -> dict:
        print("[DEBUG] handle_message called", flush=True)
        logger.info(f"[handle_message] Called with room_id={room_id}, text={text[:50]}")
        import sys; sys.stdout.flush()
        try:
            room = _get_room_context(room_id)

            # "clean_history" holds only SystemMessage, HumanMessage, and plain text
            # AIMessages (no tool_calls). This ensures Bedrock/Claude never receives an
            # AIMessage-with-tool_calls without its paired ToolMessages.
            clean_history: list = room.get("clean_history")  # type: ignore[assignment]
            if clean_history is None:
                clean_history = [SystemMessage(content=SYSTEM_PROMPT)]
                room["clean_history"] = clean_history

            # Build the input for this turn: clean history + new human message
            input_messages = clean_history + [HumanMessage(content=text)]
            logger.info(f"[handle_message] Invoking graph with {len(input_messages)} messages")
            print(f"[DEBUG] Invoking graph with {len(input_messages)} messages", flush=True)
            sys.stdout.flush()
            config: RunnableConfig = {"configurable": {"room_id": room_id}}
            logger.info(f"[handle_message] About to invoke graph...")
            print("[DEBUG] About to invoke graph...", flush=True)
            sys.stdout.flush()
            result = self._graph.invoke({"messages": input_messages}, config=config)
            logger.info(f"[handle_message] Graph invocation complete")
            # print(f"[DEBUG] Graph invocation complete. Result: {result}", flush=True)
            sys.stdout.flush()

            # Extract the final plaintext AI response and any form payload
            response_text = ""
            form_payload = None

            for msg in reversed(result["messages"]):
                if isinstance(msg, AIMessage) and not getattr(msg, "tool_calls", None):
                    response_text = msg.content or ""
                    break

            for msg in result["messages"]:
                if isinstance(msg, ToolMessage):
                    raw = msg.content
                    if not isinstance(raw, str):
                        continue
                    try:
                        parsed = json.loads(raw)
                        if isinstance(parsed, dict) and parsed.get("type") == "vm_create_form":
                            form_payload = parsed
                    except json.JSONDecodeError:
                        continue

            # Persist only the clean exchange: human turn + plain AI reply
            clean_history.append(HumanMessage(content=text))
            if response_text:
                clean_history.append(AIMessage(content=response_text))

            return {"message": response_text, "form": form_payload}
        except Exception as e:
            logger.error(f"[handle_message] Exception: {str(e)}", exc_info=True)
            import sys; sys.stdout.flush()
            return {
                "message": "I hit an internal error while processing your request. Please try again.",
                "form": None,
                "error": str(e),
            }
