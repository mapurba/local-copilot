import os
import sys
import time
import traceback
import subprocess
import threading
from typing import cast
from flask import Flask, jsonify, request, render_template
import json
from pathlib import Path
import logging
from flask_socketio import SocketIO, emit, disconnect
# from dotenv import load_dotenv

from langchain_core.runnables import RunnableConfig
# load_dotenv()
# Configure logging to save to a file
logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler("debug_log.txt", mode='a'), # 'a' appends, 'w' overwrites
        logging.StreamHandler() # This keeps logs appearing in the console too
    ]
)
# Detect if running as bundled (PyInstaller) app
IS_FROZEN = getattr(sys, 'frozen', False)
if IS_FROZEN:
    # When bundled with PyInstaller, use sys._MEIPASS as base path
    BASE_DIR = sys._MEIPASS  # type: ignore[attr-defined]
    TEMPLATE_DIR = os.path.join(BASE_DIR, "web", "templates")
    STATIC_DIR = os.path.join(BASE_DIR, "web", "static")
else:
    # In development, templates/static are relative to this file's directory
    BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    print(f"[DEBUG] BASE_DIR set to: {BASE_DIR}")
    TEMPLATE_DIR = os.path.join(BASE_DIR, "web/templates")
    STATIC_DIR = os.path.join(BASE_DIR, "web/static")

# Platform-specific PTY imports
_IS_WINDOWS = sys.platform == "win32"
if not _IS_WINDOWS:
    import fcntl
    import struct
    import termios

from web.chat_agent import (
    ChatAgent,
    create_vm_confirmed,
    _current_config,
    _get_token_for_room,
    _get_room_context,
    _query_records,
    _vm_status_summary,
)
from web.session_store import store
from vm_operations import VMOperations
from config import config as app_config
from ip_manager import get_ip_manager

app = Flask(__name__, static_folder=STATIC_DIR, template_folder=TEMPLATE_DIR)
app.config["SECRET_KEY"] = "changeme"
# threading mode works on both Windows (dev) and Linux (Docker)
socketio = SocketIO(app, async_mode="threading", cors_allowed_origins="*", manage_session=False)

if IS_FROZEN:
    print(f"[DEBUG] Running in bundled/frozen mode")
    print(f"[DEBUG] BASE_DIR={BASE_DIR}")
    print(f"[DEBUG] TEMPLATE_DIR={TEMPLATE_DIR}")
    print(f"[DEBUG] STATIC_DIR={STATIC_DIR}")
    if not os.path.exists(TEMPLATE_DIR):
        print(f"[ERROR] Template directory not found: {TEMPLATE_DIR}")
    if not os.path.exists(STATIC_DIR):
        print(f"[ERROR] Static directory not found: {STATIC_DIR}")

agent = ChatAgent()

# ── PTY terminal sessions ─────────────────────────────────────────────
# { (socket_sid, tab_id): { "fd": master_fd|None, "proc": Popen|WinPty, "win": bool } }
_terminal_sessions: dict[tuple[str, str], dict] = {}
_terminal_lock = threading.Lock()


def _pty_read_loop(sid: str, fd: int, tab_id: str) -> None:
    """Background thread (Linux): reads PTY master fd and emits to the owning socket."""
    try:
        while True:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                break
            socketio.emit("terminal_output", {"tab_id": tab_id, "data": data.decode("utf-8", errors="replace")}, to=sid)
    finally:
        socketio.emit("terminal_closed", {"tab_id": tab_id}, to=sid)


def _pty_read_loop_win(sid: str, pty_proc, tab_id: str) -> None:
    """Background thread (Windows): reads winpty process and emits to the owning socket."""
    try:
        while pty_proc.isalive():
            try:
                data = pty_proc.read(4096)
                if data:
                    socketio.emit("terminal_output", {"tab_id": tab_id, "data": data}, to=sid)
            except Exception:
                break
            time.sleep(0.01)
    finally:
        socketio.emit("terminal_closed", {"tab_id": tab_id}, to=sid)


@app.errorhandler(Exception)
def handle_exception(e):
    """Return JSON for all unhandled exceptions so the browser never sees an HTML 500 page."""
    traceback.print_exc()
    return jsonify({"error": str(e)}), 500


@app.errorhandler(404)
def handle_404(e):
    return jsonify({"error": "Not found"}), 404


def _require_room(data: dict):
    """Return (room_id, None) on success, or (None, error_response) when the session is missing."""
    room_id = data.get("room_id", "")
    if not room_id:
        return None, (jsonify({"error": "room_id required"}), 400)
    room = store.get_room(room_id)
    if not room:
        return None, (
            jsonify({"error": "Session expired. Please log in again.", "code": "SESSION_EXPIRED"}),
            401,
        )
    return room_id, None


@app.get("/")
def index():
    return render_template("index.html")


@app.post("/api/login")
def login():
    data = request.get_json(force=True)
    username = data.get("username", "").strip()
    password = data.get("password", "").strip()
    org = data.get("org", "").strip()

    if not username or not password or not org:
        return jsonify({"error": "username, password, and org are required"}), 400

    room_id = store.create_room(username=username, org=org, password=password)
    return jsonify({"room_id": room_id})


@app.post("/api/chat")
def chat():
    logger = logging.getLogger(__name__)
    try:
        logger.info(f"[/api/chat] Received chat request")
    except Exception:
        pass
    data = request.get_json(force=True)
    try:
        logger.info(f"[/api/chat] Request body: {data}")
    except Exception:
        pass
    room_id, err = _require_room(data)
    if err:
        try:
            logger.error(f"[/api/chat] Room validation failed")
        except Exception:
            pass
        return err
    assert room_id is not None
    message = data.get("message", "")
    try:
        logger.info(f"[/api/chat] room_id={room_id}, message={message[:50]}")
    except Exception:
        pass
    if not message:
        return jsonify({"error": "message is required"}), 400
    try:
        logger.info(f"[/api/chat] Calling agent.handle_message")
    except Exception:
        pass
    try:
        response = agent.handle_message(room_id, message)
        try:
            logger.info(f"[/api/chat] Response: {str(response)[:100]}")
        except Exception:
            pass
        return jsonify(response)
    except Exception as e:
        try:
            logger.error(f"[/api/chat] Exception: {str(e)}", exc_info=True)
        except Exception:
            pass
        return jsonify({"error": str(e)}), 500


@app.post("/api/confirm_create")
def confirm_create():
    data = request.get_json(force=True)
    room_id, err = _require_room(data)
    if err:
        return err
    assert room_id is not None
    form = data.get("form", {})
    if not isinstance(form, dict):
        return jsonify({"error": "form must be an object"}), 400
    store.set_pending_form(room_id, form)
    runnable_config = cast(RunnableConfig, {"configurable": {"room_id": room_id}})
    cv_token = _current_config.set(runnable_config)
    try:
        result = create_vm_confirmed.invoke({}, config=runnable_config)
    finally:
        _current_config.reset(cv_token)
    message = "VM creation request submitted."
    if isinstance(result, dict):
        if result.get("status") == "error":
            message = result.get("message", "VM creation failed.")
        elif result.get("status") == "success":
            vm_name = form.get("vm_name", "")
            status_code = result.get("result", {}).get("status_code", "")
            message = f"✅ VM '{vm_name}' created successfully (HTTP {status_code})."
    return jsonify({"message": message, "result": result})


@app.post("/api/vms")
def api_list_vms():
    data = request.get_json(force=True)
    room_id, err = _require_room(data)
    if err:
        return err
    assert room_id is not None
    room = _get_room_context(room_id)
    token = _get_token_for_room(room_id)
    username = room.get("username", "")
    from web.chat_agent import _matches_owner  # noqa: PLC0415
    vms = _query_records(
        token, "vm",
        extra_filter=f"ownerName==*{username}*;isVAppTemplate==false",
        sort_desc="dateCreated",
    )
    user_vms = [_vm_status_summary(vm) for vm in vms if _matches_owner(vm.get("ownerName", ""), username)]
    return jsonify({"vms": user_vms})


@app.post("/api/vm/start")
def api_vm_start():
    data = request.get_json(force=True)
    room_id, err = _require_room(data)
    if err:
        return err
    assert room_id is not None
    vm_href = data.get("vm_href", "")
    if not vm_href:
        return jsonify({"error": "vm_href required"}), 400
    token = _get_token_for_room(room_id)
    vm_ops = VMOperations(app_config.VCD_HOST, token, api_version=app_config.API_VERSION)
    result = vm_ops.power_on_vm(vm_href)
    return jsonify(result)


@app.post("/api/vm/stop")
def api_vm_stop():
    data = request.get_json(force=True)
    room_id, err = _require_room(data)
    if err:
        return err
    assert room_id is not None
    vm_href = data.get("vm_href", "")
    if not vm_href:
        return jsonify({"error": "vm_href required"}), 400
    token = _get_token_for_room(room_id)
    vm_ops = VMOperations(app_config.VCD_HOST, token, api_version=app_config.API_VERSION)
    result = vm_ops.power_off_vm(vm_href)
    return jsonify(result)


# ── SocketIO terminal events ──────────────────────────────────────────

@socketio.on("terminal_open")
def on_terminal_open(payload):
    sid = request.sid  # type: ignore[attr-defined]
    room_id = payload.get("room_id", "")
    vm_ip   = payload.get("vm_ip", "")
    tab_id  = payload.get("tab_id", "")

    if not room_id or not store.get_room(room_id):
        emit("terminal_error", {"tab_id": tab_id, "message": "Invalid session."})
        return

    prefill = f"ssh user@{vm_ip}" if vm_ip else ""

    if _IS_WINDOWS:
        # ── Windows: use pywinpty ─────────────────────────────────────
        try:
            import winpty  # type: ignore
        except ImportError:
            emit("terminal_error", {"tab_id": tab_id, "message": "pywinpty not installed. Run: pip install pywinpty"})
            return
        pty_proc = winpty.PtyProcess.spawn(
            "powershell -NoLogo",
            dimensions=(24, 80),
            env={**os.environ, "TERM": "xterm-256color"},
        )
        if prefill:
            time.sleep(0.4)  # wait for shell prompt
            pty_proc.write(prefill)
        with _terminal_lock:
            _terminal_sessions[(sid, tab_id)] = {"proc": pty_proc, "fd": None, "win": True}
        socketio.start_background_task(_pty_read_loop_win, sid, pty_proc, tab_id)
    else:
        # ── Linux/Mac: use os.openpty ─────────────────────────────────
        master_fd, slave_fd = os.openpty()
        def _set_controlling_tty() -> None:
            os.setsid()
            fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
        proc = subprocess.Popen(
            ["bash", "--norc", "--noprofile"],
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            close_fds=True,
            env={**os.environ, "TERM": "xterm-256color"},
            preexec_fn=_set_controlling_tty,
        )
        os.close(slave_fd)
        if prefill:
            cmd = (prefill).encode()
            os.write(master_fd, cmd)
        with _terminal_lock:
            _terminal_sessions[(sid, tab_id)] = {"fd": master_fd, "proc": proc, "win": False}
        socketio.start_background_task(_pty_read_loop, sid, master_fd, tab_id)


@socketio.on("terminal_input")
def on_terminal_input(payload):
    sid = request.sid  # type: ignore[attr-defined]
    tab_id = payload.get("tab_id", "")
    data = payload.get("input", "")
    if not tab_id:
        return
    with _terminal_lock:
        session = _terminal_sessions.get((sid, tab_id))
    if not session or not data:
        return
    try:
        if session.get("win"):
            session["proc"].write(data if isinstance(data, str) else data.decode())
        else:
            os.write(session["fd"], data.encode("utf-8") if isinstance(data, str) else data)
    except OSError:
        pass


@app.route("/api/res-ip", methods=["POST"])
def register_ip():
    """
    Register or update an IP address in the IP allocation tracking system.
    
    Expected JSON payload:
    {
        "ip": "164.99.91.100",
        "status": "used",  # or "free"
        "hostname": "vm-name" (optional)
    }
    """
    try:
        data = request.get_json() or {}
        ip = data.get("ip", "").strip()
        status = data.get("status", "used").lower()
        hostname = data.get("hostname", "").strip()
        
        if not ip:
            return jsonify({"status": "error", "message": "IP address is required"}), 400
        
        if status not in ["used", "free"]:
            return jsonify({"status": "error", "message": "Status must be 'used' or 'free'"}), 400
        
        ip_manager = get_ip_manager()
        result = ip_manager.register_ip(ip, status, hostname)
        
        return jsonify(result), 200
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/res-ip/list", methods=["GET"])
def list_ips():
    """
    Get list of all tracked IPs organized by status.
    
    Returns JSON with 'used' and 'free' IP lists.
    """
    try:
        ip_manager = get_ip_manager()
        all_ips = ip_manager.get_all_ips()
        return jsonify(all_ips), 200
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/res-ip/free", methods=["GET"])
def get_free_ips():
    """
    Get list of all free IPs available for allocation.
    """
    try:
        ip_manager = get_ip_manager()
        free_ips = ip_manager.get_free_ips()
        return jsonify({"status": "success", "free_ips": free_ips, "count": len(free_ips)}), 200
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/res-ip/allocate", methods=["POST"])
def allocate_ip():
    """
    Allocate the first available free IP from the pool.
    
    Expected JSON payload:
    {
        "hostname": "vm-name" (optional)
    }
    
    Returns the allocated IP or error if none available.
    """
    try:
        data = request.get_json(silent=True) or {}
        hostname = data.get("hostname", "").strip()
        
        ip_manager = get_ip_manager()
        result = ip_manager.allocate_ip(hostname)
        
        status_code = 200 if result.get("status") == "success" else 400
        return jsonify(result), status_code
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/proxy/res-ip/allocate", methods=["POST"])
def proxy_allocate_ip():
    """
    Proxy POST requests to the remote IP allocation service at
    http://164.99.91.31:5100/api/res-ip/allocate, forwarding the request body
    and returning the remote response as-is.
    """
    import requests as _requests
    REMOTE_URL = "http://164.99.91.31:5100/api/res-ip/allocate"
    try:
        payload = request.get_json(silent=True) or {}
        resp = _requests.post(REMOTE_URL, json=payload, timeout=15)
        try:
            return jsonify(resp.json()), resp.status_code
        except ValueError:
            return resp.text, resp.status_code, {"Content-Type": resp.headers.get("Content-Type", "text/plain")}
    except _requests.exceptions.ConnectionError as e:
        return jsonify({"status": "error", "message": f"Cannot reach remote service: {e}"}), 502
    except _requests.exceptions.Timeout:
        return jsonify({"status": "error", "message": "Remote service timed out"}), 504
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@socketio.on("terminal_resize")
def on_terminal_resize(payload):
    sid = request.sid  # type: ignore[attr-defined]
    tab_id = payload.get("tab_id", "")
    if not tab_id:
        return
    with _terminal_lock:
        session = _terminal_sessions.get((sid, tab_id))
    if not session:
        return
    rows = int(payload.get("rows", 24))
    cols = int(payload.get("cols", 80))
    try:
        if session.get("win"):
            session["proc"].set_size(rows, cols)
        else:
            fcntl.ioctl(session["fd"], termios.TIOCSWINSZ,
                        struct.pack("HHHH", rows, cols, 0, 0))
    except OSError:
        pass


@socketio.on("terminal_close")
def on_terminal_close(payload):
    sid = request.sid  # type: ignore[attr-defined]
    tab_id = payload.get("tab_id", "")
    _cleanup_terminal(sid, tab_id)


@socketio.on("disconnect")
def on_disconnect():
    _cleanup_terminal(request.sid)  # type: ignore[attr-defined]

def get_llm_config_path():
    # Store config in userData (Roaming/VCD-Agent/llm_config.json)
    if IS_FROZEN:
        base = os.path.expanduser('~')
        config_dir = os.path.join(base, 'AppData', 'Roaming', 'VCD-Agent')
    else:
        config_dir = os.path.join(os.path.dirname(__file__), '..', '..', 'llm_config_dev')
    os.makedirs(config_dir, exist_ok=True)
    return os.path.join(config_dir, 'llm_config.json')

def load_llm_config():
    path = get_llm_config_path()
    if os.path.exists(path):
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    return {
        "provider": "ollama",
        "model": "qwen3-embedding:8b",
        "credentials": {}
    }

def save_llm_config(cfg):
    path = get_llm_config_path()
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, indent=2)

# API: Get current LLM config
@app.route('/api/llm/config', methods=['GET'])
def api_get_llm_config():
    return jsonify(load_llm_config())

# API: Set LLM config (provider/model/credentials)
@app.route('/api/llm/config', methods=['POST'])
def api_set_llm_config():
    data = request.get_json(force=True)
    cfg = load_llm_config()
    for k in ["provider", "model", "credentials"]:
        if k in data:
            cfg[k] = data[k]
    save_llm_config(cfg)
    return jsonify({"status": "ok"})

# ── GitHub Copilot OAuth device flow ─────────────────────────────────
_COPILOT_CLIENT_ID = os.environ.get("COPILOT_CLIENT_ID", "Iv1.b507a08c87ecfe98")


@app.post("/api/copilot/auth/start")
def copilot_auth_start():
    """Initiate GitHub device authorization flow for Copilot."""
    import requests as _req
    try:
        resp = _req.post(
            "https://github.com/login/device/code",
            json={"client_id": _COPILOT_CLIENT_ID, "scope": "read:user"},
            headers={"Accept": "application/json"},
            timeout=15,
        )
        resp.raise_for_status()
        return jsonify(resp.json()), resp.status_code
    except Exception as e:
        return jsonify({"error": str(e)}), 502


@app.post("/api/copilot/auth/poll")
def copilot_auth_poll():
    """Poll GitHub for an OAuth access token after user completes device auth."""
    import requests as _req
    data = request.get_json(force=True)
    device_code = data.get("device_code", "")
    if not device_code:
        return jsonify({"error": "device_code required"}), 400
    try:
        resp = _req.post(
            "https://github.com/login/oauth/access_token",
            json={
                "client_id": _COPILOT_CLIENT_ID,
                "device_code": device_code,
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            },
            headers={"Accept": "application/json"},
            timeout=15,
        )
        resp.raise_for_status()
        result = resp.json()
        if "access_token" in result:
            # Persist the GitHub OAuth token so ChatAgent can use it
            cfg = load_llm_config()
            cfg["provider"] = "copilot"
            cfg["model"] = cfg.get("model") or "gpt-4o"
            creds = cfg.get("credentials") or {}
            creds["github_token"] = result["access_token"]
            cfg["credentials"] = creds
            save_llm_config(cfg)
            # Re-initialize the agent with the new config
            global agent
            agent = ChatAgent()
            result["authenticated"] = True
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 502


@app.get("/api/copilot/status")
def copilot_status():
    """Return current Copilot authentication status."""
    cfg = load_llm_config()
    if cfg.get("provider") == "copilot" and cfg.get("credentials", {}).get("github_token"):
        return jsonify({"connected": True, "model": cfg.get("model", "gpt-4o")})
    return jsonify({"connected": False})


def _cleanup_terminal(sid: str, tab_id: str | None = None) -> None:
    to_cleanup: list[dict] = []
    with _terminal_lock:
        if tab_id:
            session = _terminal_sessions.pop((sid, tab_id), None)
            if session:
                to_cleanup.append(session)
        else:
            keys = [key for key in _terminal_sessions if key[0] == sid]
            for key in keys:
                session = _terminal_sessions.pop(key, None)
                if session:
                    to_cleanup.append(session)
    for session in to_cleanup:
        try:
            session["proc"].terminate()
        except Exception:
            pass
        if session.get("fd") is not None:
            try:
                os.close(session["fd"])
            except Exception:
                pass


if __name__ == "__main__":
    port = 5002
    # Use 0.0.0.0 to allow external access
    socketio.run(app, host="0.0.0.0", port=port, debug=True, allow_unsafe_werkzeug=True)
