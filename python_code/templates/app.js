/* =====================================================================
   VCD Assistant – Frontend
   ===================================================================== */

// ── State ──────────────────────────────────────────────────────────────
let roomId       = null;
let pendingForm  = null;       // vm_create_form payload from the AI
let allVms       = [];         // full VM list fetched from /api/vms
let activeFilter = "all";      // all | on | off

// ── Terminal state ─────────────────────────────────────────────────────
let socket       = null;
let termCounter  = 0;
let activePaneId = "chat";
// { tabId: { term, fitAddon, tabEl, paneEl, resizeObs } }
const terminals  = {};

// ── DOM refs ───────────────────────────────────────────────────────────
const loginScreen   = document.getElementById("login-screen");
const loginForm     = document.getElementById("login-form");
const loginBtn      = document.getElementById("login-btn");
const loginError    = document.getElementById("login-error");

const app           = document.getElementById("app");
const topbarUser    = document.getElementById("topbar-user");

const vmList        = document.getElementById("vm-list");
const refreshBtn    = document.getElementById("refresh-vms");

const chatMessages  = document.getElementById("chat-messages");
const chatForm      = document.getElementById("chat-form");
const chatInput     = document.getElementById("chat-input");
const sendBtn       = document.getElementById("send-btn");

const createVmForm  = document.getElementById("create-vm-form");
const createStatus  = document.getElementById("create-status");
const fetchFreeIpBtn = document.getElementById("fetch-free-ip");

const panelTabbar   = document.getElementById("panel-tabbar");
// Show current LLM in chat UI
let currentLLM = null;
const llmStatusEl = document.getElementById('llm-status');
async function updateLLMStatus() {
    try {
        const res = await fetch('/api/llm/config');
        const cfg = await res.json();
        currentLLM = cfg;
        let txt = '';
        if (cfg.provider === 'copilot') {
            txt = `LLM: GitHub Copilot (${cfg.model || 'gpt-4o'})`;
        } else if (cfg.provider === 'ollama') {
            txt = `LLM: Ollama (${cfg.model || 'llama3.2:1b'})`;
        } else if (cfg.provider === 'bedrock') {
            txt = `LLM: Bedrock (${cfg.credentials?.bedrock_model_id || 'claude-3-5-sonnet'})`;
        } else if (cfg.provider === 'gemini') {
            txt = `LLM: Gemini (${cfg.credentials?.gemini_model || 'gemini-1.5-flash-latest'})`;
        } else if (cfg.provider === 'openai') {
            txt = `LLM: OpenAI (${cfg.credentials?.openai_model || 'gpt-4o'})`;
        } else {
            txt = `LLM: ${cfg.provider}`;
        }
        if (llmStatusEl) llmStatusEl.textContent = txt;
    } catch (e) {
        if (llmStatusEl) llmStatusEl.textContent = '';
    }
}
window.addEventListener('DOMContentLoaded', updateLLMStatus);
document.addEventListener('llm-config-changed', updateLLMStatus);
// Patch LLM config modal save to dispatch event
const origLlmConfigForm = document.getElementById('llmConfigForm');
if (origLlmConfigForm) {
    const origSubmit = origLlmConfigForm.onsubmit;
    origLlmConfigForm.onsubmit = async function(e) {
        if (origSubmit) await origSubmit.call(this, e);
        setTimeout(() => document.dispatchEvent(new Event('llm-config-changed')), 200);
    };
}
const panelContent  = document.getElementById("panel-content");
const sidebar       = document.getElementById("sidebar");
const divider       = document.getElementById("panel-divider");

// Active review card node (only one at a time)
let activeReviewCard = null;

// ── Utility ────────────────────────────────────────────────────────────
async function apiPost(url, payload) {
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });

    const text = await res.text();
    let body;
    try {
        body = JSON.parse(text);
    } catch {
        throw new Error(`Server error (${res.status}): unexpected response from server`);
    }

    if (!res.ok) {
        if (res.status === 401 && body.code === "SESSION_EXPIRED") {
            handleSessionExpired();
        }
        throw new Error(body.error || res.statusText);
    }
    return body;
}

function handleSessionExpired() {
    roomId = null;
    app.classList.add("hidden");
    loginScreen.classList.remove("hidden");
    loginError.textContent = "Your session expired. Please sign in again.";
}

// ── GitHub Copilot Auth ────────────────────────────────────────────────
const copilotConnectBtn      = document.getElementById("copilot-connect-btn");
const copilotConnectedRow    = document.getElementById("copilot-connected-row");
const copilotDisconnectedRow = document.getElementById("copilot-disconnected-row");
const copilotDeviceFlow      = document.getElementById("copilot-device-flow");
const copilotUserCodeEl      = document.getElementById("copilot-user-code");
const copilotErrorEl         = document.getElementById("copilot-error");

const _COPILOT_BTN_HTML = copilotConnectBtn ? copilotConnectBtn.innerHTML : "";
let _copilotPollTimer = null;

async function checkCopilotStatus() {
    try {
        const res = await fetch("/api/copilot/status");
        const data = await res.json();
        if (data.connected) {
            showCopilotConnected();
        }
    } catch (_) {}
}

function showCopilotConnected() {
    copilotConnectedRow.classList.remove("hidden");
    copilotDisconnectedRow.classList.add("hidden");
    copilotDeviceFlow.classList.add("hidden");
    if (copilotErrorEl) copilotErrorEl.textContent = "";
    document.dispatchEvent(new Event("llm-config-changed"));
}

async function startCopilotAuth() {
    copilotConnectBtn.disabled = true;
    copilotConnectBtn.textContent = "Connecting…";
    if (copilotErrorEl) copilotErrorEl.textContent = "";
    try {
        const res = await fetch("/api/copilot/auth/start", { method: "POST" });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        copilotUserCodeEl.textContent = data.user_code || "";
        copilotDeviceFlow.classList.remove("hidden");

        // Start polling
        const deviceCode = data.device_code;
        const interval   = (data.interval || 5) * 1000;
        _copilotPollTimer = setInterval(() => pollCopilotAuth(deviceCode), interval);
    } catch (err) {
        if (copilotErrorEl) copilotErrorEl.textContent = `Copilot error: ${err.message}`;
        copilotConnectBtn.disabled = false;
        copilotConnectBtn.innerHTML = _COPILOT_BTN_HTML;
    }
}

async function pollCopilotAuth(deviceCode) {
    try {
        const res  = await fetch("/api/copilot/auth/poll", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ device_code: deviceCode }),
        });
        const data = await res.json();

        if (data.authenticated) {
            clearInterval(_copilotPollTimer);
            showCopilotConnected();
        } else if (data.error === "access_denied" || data.error === "expired_token") {
            clearInterval(_copilotPollTimer);
            copilotDeviceFlow.classList.add("hidden");
            copilotConnectBtn.disabled = false;
            if (copilotErrorEl) copilotErrorEl.textContent = "Authorization denied or timed out. Please try again.";
        }
        // "authorization_pending" and "slow_down" → keep polling
    } catch (_) {}
}

if (copilotConnectBtn) {
    copilotConnectBtn.addEventListener("click", startCopilotAuth);
}

// Check status on page load
window.addEventListener("DOMContentLoaded", checkCopilotStatus);

// ── Login ─────────────────────────────────────────────────────────────
loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    loginError.textContent = "";
    loginBtn.disabled = true;
    loginBtn.textContent = "Signing in…";

    try {
        const data = await apiPost("/api/login", {
            username: document.getElementById("username").value.trim(),
            org:      document.getElementById("org").value.trim(),
            password: document.getElementById("password").value,
        });
        roomId = data.room_id;
        const username = document.getElementById("username").value.trim();
        topbarUser.textContent = `${username}`;

        loginScreen.classList.add("hidden");
        app.classList.remove("hidden");

        initSocket();
        addMessage("system", "Session started. Your VMs are shown in the sidebar.");
        loadVms();
    } catch (err) {
        loginError.textContent = err.message;
    } finally {
        loginBtn.disabled = false;
        loginBtn.textContent = "Start Session";
    }
});

// ── Socket.IO ─────────────────────────────────────────────────────────
function initSocket() {
    socket = io();

    socket.on("terminal_output", ({ tab_id, data }) => {
        const t = terminals[tab_id];
        if (t) t.term.write(data);
    });

    socket.on("terminal_closed", ({ tab_id }) => {
        const t = terminals[tab_id];
        if (t) t.term.write("\r\n\x1b[33m[Connection closed]\x1b[0m\r\n");
    });

    socket.on("terminal_error", ({ tab_id, message }) => {
        const t = terminals[tab_id];
        if (t) t.term.write(`\r\n\x1b[31m[Error: ${message}]\x1b[0m\r\n`);
    });
}

// ── Tab management ────────────────────────────────────────────────────
function switchTab(paneId) {
    activePaneId = paneId;

    // Update tab bar highlights
    panelTabbar.querySelectorAll(".panel-tab").forEach((el) => {
        el.classList.toggle("active", el.dataset.pane === paneId);
    });

    // Show/hide panes
    panelContent.querySelectorAll(".panel-pane").forEach((el) => {
        el.classList.toggle("active", el.id === `pane-${paneId}`);
    });

    // Fit terminal if switching to one
    const t = terminals[paneId];
    if (t) {
        requestAnimationFrame(() => { try { t.fitAddon.fit(); } catch (_) {} });
    }
}

// ── Open terminal tab for a VM ────────────────────────────────────────
function openTerminalTab(vm) {
    termCounter++;
    const tabId = `term-${termCounter}`;
    const label = vm.name || vm.ip || "Terminal";

    // ── Tab pill ─────────────────────────────────────────────────────
    const tabEl = document.createElement("div");
    tabEl.className = "panel-tab";
    tabEl.dataset.pane = tabId;
    tabEl.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
            <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
        </svg>
        <span>${esc(label)}</span>
        <button class="tab-close" title="Close terminal">&times;</button>`;
    tabEl.addEventListener("click", (e) => {
        if (e.target.classList.contains("tab-close")) return;
        switchTab(tabId);
    });
    tabEl.querySelector(".tab-close").addEventListener("click", () => closeTerminalTab(tabId));
    panelTabbar.appendChild(tabEl);

    // ── Pane ──────────────────────────────────────────────────────────
    const paneEl = document.createElement("div");
    paneEl.className = "panel-pane terminal-pane";
    paneEl.id = `pane-${tabId}`;
    panelContent.appendChild(paneEl);

    // ── xterm.js ──────────────────────────────────────────────────────
    const term = new Terminal({
        theme: {
            background: "#0d0d0d",
            foreground: "#d4d4d4",
            cursor:     "#c9462b",
            selectionBackground: "rgba(201,70,43,.3)",
        },
        cursorBlink:  true,
        fontFamily:   "'Cascadia Code', 'Fira Code', 'Consolas', 'Courier New', monospace",
        fontSize:     14,
        lineHeight:   1.4,
        allowTransparency: false,
        scrollback:   5100,
    });

    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(paneEl);

    // Fit once visible
    switchTab(tabId);
    requestAnimationFrame(() => { try { fitAddon.fit(); } catch (_) {} });

    // ── Wire input to server ──────────────────────────────────────────
    term.onData((data) => {
        if (socket) socket.emit("terminal_input", { tab_id: tabId, input: data });
    });

    // ── ResizeObserver → fit + server resize ──────────────────────────
    const resizeObs = new ResizeObserver(() => {
        if (activePaneId !== tabId) return;
        try {
            fitAddon.fit();
            if (socket) socket.emit("terminal_resize", { tab_id: tabId, rows: term.rows, cols: term.cols });
        } catch (_) {}
    });
    resizeObs.observe(paneEl);

    terminals[tabId] = { term, fitAddon, tabEl, paneEl, resizeObs };

    // ── Ask server to open PTY ────────────────────────────────────────
    if (socket) {
        socket.emit("terminal_open", { room_id: roomId, vm_ip: vm.ip || "", tab_id: tabId });
    } else {
        term.write("\x1b[31m[Socket not connected. Please reload.]\x1b[0m\r\n");
    }
}

function closeTerminalTab(tabId) {
    const t = terminals[tabId];
    if (!t) return;

    // Notify server
    if (socket) socket.emit("terminal_close", { tab_id: tabId });

    t.resizeObs.disconnect();
    t.term.dispose();
    t.tabEl.remove();
    t.paneEl.remove();
    delete terminals[tabId];

    if (activePaneId === tabId) switchTab("chat");
}

// ── Sidebar tabs ──────────────────────────────────────────────────────
document.querySelectorAll(".stab").forEach((btn) => {
    btn.addEventListener("click", () => {
        document.querySelectorAll(".stab").forEach((b) => b.classList.remove("active"));
        document.querySelectorAll(".stab-content").forEach((c) => c.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    });
});

// Wire pinned Chat tab
document.getElementById("tab-chat").addEventListener("click", () => switchTab("chat"));

// ── Draggable sidebar divider ─────────────────────────────────────────
(function () {
    let dragging = false;
    let startX = 0;
    let startW = 0;

    divider.addEventListener("mousedown", (e) => {
        dragging = true;
        startX = e.clientX;
        startW = sidebar.getBoundingClientRect().width;
        divider.classList.add("dragging");
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        const delta = e.clientX - startX;
        const newW  = Math.min(500, Math.max(180, startW + delta));
        sidebar.style.width = newW + "px";
    });

    document.addEventListener("mouseup", () => {
        if (!dragging) return;
        dragging = false;
        divider.classList.remove("dragging");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        // Re-fit active terminal after resize
        const t = terminals[activePaneId];
        if (t) requestAnimationFrame(() => { try { t.fitAddon.fit(); } catch (_) {} });
    });
})();

// ── VM list ───────────────────────────────────────────────────────────
async function loadVms() {
    if (!roomId) return;
    refreshBtn.classList.add("spinning");
    vmList.innerHTML = `<div class="vm-placeholder">Loading…</div>`;
    try {
        const data = await apiPost("/api/vms", { room_id: roomId });
        allVms = data.vms || [];
        renderVmList();
    } catch (err) {
        vmList.innerHTML = `<div class="vm-placeholder">Error: ${esc(err.message)}</div>`;
    } finally {
        refreshBtn.classList.remove("spinning");
    }
}

function renderVmList() {
    let vms = allVms;
    if (activeFilter === "on")  vms = vms.filter((v) => v.powered_on);
    if (activeFilter === "off") vms = vms.filter((v) => !v.powered_on);

    if (!vms.length) {
        vmList.innerHTML = `<div class="vm-placeholder">${activeFilter === "all" ? "No VMs found." : "No VMs match this filter."}</div>`;
        return;
    }

    vmList.innerHTML = "";
    vms.forEach((vm) => {
        const item = document.createElement("div");
        item.className = "vm-item";
        const dotClass = vm.powered_on ? "on" : "off";
        item.innerHTML = `
            <div class="vm-item-header">
                <div class="vm-dot ${dotClass}"></div>
                <div class="vm-name" title="${esc(vm.name)}">${esc(vm.name)}</div>
            </div>
            ${vm.ip ? `<div class="vm-ip">${esc(vm.ip)}</div>` : ""}
            <div class="vm-actions">
                <button class="vm-action-btn start" data-href="${esc(vm.href)}" ${vm.powered_on ? "disabled" : ""}>▶ Start</button>
                <button class="vm-action-btn stop"  data-href="${esc(vm.href)}" ${!vm.powered_on ? "disabled" : ""}>■ Stop</button>
                ${vm.powered_on ? `<button class="vm-terminal-btn" title="Open SSH terminal">&gt;_</button>` : ""}
            </div>`;

        item.querySelector(".vm-action-btn.start").addEventListener("click", () => vmPower(vm.href, "start", item));
        item.querySelector(".vm-action-btn.stop").addEventListener("click",  () => vmPower(vm.href, "stop",  item));

        if (vm.powered_on) {
            item.querySelector(".vm-terminal-btn").addEventListener("click", () => openTerminalTab(vm));
        }

        vmList.appendChild(item);
    });
}

async function vmPower(href, action, itemEl) {
    const btns = itemEl.querySelectorAll(".vm-action-btn");
    btns.forEach((b) => (b.disabled = true));
    const url = action === "start" ? "/api/vm/start" : "/api/vm/stop";
    const vmName = itemEl.querySelector(".vm-name").textContent;
    try {
        await apiPost(url, { room_id: roomId, vm_href: href });
        addMessage("system", `VM "${vmName}" ${action === "start" ? "powered on" : "powered off"} successfully.`);
        await loadVms();
    } catch (err) {
        addMessage("error", `Failed to ${action} "${vmName}": ${err.message}`);
        btns.forEach((b) => (b.disabled = false));
    }
}

refreshBtn.addEventListener("click", loadVms);

document.querySelectorAll(".filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
        document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        activeFilter = btn.dataset.filter;
        renderVmList();
    });
});

// ── Chat ──────────────────────────────────────────────────────────────
function addMessage(role, text) {
    const welcome = chatMessages.querySelector(".welcome-msg");
    if (welcome) welcome.remove();

    const row = document.createElement("div");
    row.className = `msg-row ${role}`;

    const avatarText = role === "user" ? "You" : role === "system" ? "ℹ" : "AI";
    row.innerHTML = `
        <div class="msg-avatar">${avatarText}</div>
        <div class="msg-bubble">${esc(text)}</div>`;

    chatMessages.appendChild(row);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return row;
}

function addTypingIndicator() {
    const row = document.createElement("div");
    row.className = "msg-row assistant msg-typing";
    row.id = "typing-row";
    row.innerHTML = `<div class="msg-avatar">AI</div><div class="msg-bubble">Thinking…</div>`;
    chatMessages.appendChild(row);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function removeTypingIndicator() {
    const el = document.getElementById("typing-row");
    if (el) el.remove();
}

chatForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text || !roomId) return;

    // Switch to chat pane when sending a message
    switchTab("chat");

    addMessage("user", text);
    chatInput.value = "";
    sendBtn.disabled = true;
    addTypingIndicator();

    try {
        const res = await apiPost("/api/chat", { room_id: roomId, message: text });
        removeTypingIndicator();
        if (res.message) addMessage("assistant", res.message);
        if (res.form && res.form.type === "vm_create_form") {
            pendingForm = res.form.form;
            showReviewBar(pendingForm);
        }
    } catch (err) {
        removeTypingIndicator();
        addMessage("error", `Error: ${err.message}`);
    } finally {
        sendBtn.disabled = false;
        chatInput.focus();
    }
});

// ── Review card (AI-drafted VM form, injected inline into chat) ────────
function showReviewBar(form) {
    if (activeReviewCard) { activeReviewCard.remove(); activeReviewCard = null; }

    const FIELDS = [
        ["vm_name",            "VM Name"],
        ["template_id",        "Template ID"],
        ["network_name",       "Network"],
        ["ip_address",         "IP Address"],
        ["gateway",            "Gateway"],
        ["dns_servers",        "DNS Servers"],
        ["power_on",           "Power On"],
        ["storage_profile_id", "Storage Profile"],
        ["compute_policy_id",  "Compute Policy"],
        ["setup_ilm",  "Setup ILM"],
        ["ilm_version",  "ILM Version"],
    ];

    const card = document.createElement("div");
    card.className = "review-card";

    const title = document.createElement("div");
    title.className = "review-card-title";
    title.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        Review &amp; edit VM details before deploying`;
    card.appendChild(title);

    const fieldsGrid = document.createElement("div");
    fieldsGrid.className = "review-card-fields";
    let ipInputEl = null;
    let fetchIpBtnEl = null;
    FIELDS.forEach(([key, label]) => {
        const wrap = document.createElement("div");
        wrap.className = "field";
        wrap.innerHTML = `<label>${label}</label>`;
        let input;
        if (key === "power_on") {
            input = document.createElement("select");
            ["true", "false"].forEach((v) => {
                const opt = document.createElement("option");
                opt.value = v;
                opt.textContent = v === "true" ? "Yes" : "No";
                opt.selected = String(form[key]) === v;
                input.appendChild(opt);
            });
        }
        else if (key === "setup_ilm") {
            input = document.createElement("select");
            ["true", "false"].forEach((v) => {
                const opt = document.createElement("option");
                opt.value = v;
                opt.textContent = v === "true" ? "true" : "false";
                opt.selected = String(form[key]) === v;
                input.appendChild(opt);
            });
        } else {
            input = document.createElement("input");
            input.type = "text";
            input.value = form[key] ?? "";
        }
        input.dataset.key = key;
        if (key === "ip_address") {
            input.style.width="60%"
            const row = document.createElement("div");
            row.className = "field-row";
            fetchIpBtnEl = document.createElement("button");
            fetchIpBtnEl.type = "button";
            fetchIpBtnEl.className = "btn-ghost btn-small";
            fetchIpBtnEl.textContent = "Fetch Free IP";
            row.appendChild(input);
            row.appendChild(fetchIpBtnEl);
            wrap.appendChild(row);
            ipInputEl = input;
        } else {
            wrap.appendChild(input);
        }
        fieldsGrid.appendChild(wrap);
    });
    card.appendChild(fieldsGrid);

    const actions = document.createElement("div");
    actions.className = "review-card-actions";
    const deployBtn = document.createElement("button");
    deployBtn.className = "btn-primary";
    deployBtn.textContent = "Deploy VM";
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn-ghost";
    cancelBtn.textContent = "Cancel";
    actions.appendChild(deployBtn);
    actions.appendChild(cancelBtn);
    card.appendChild(actions);

    const row = document.createElement("div");
    row.className = "msg-row assistant";
    row.innerHTML = `<div class="msg-avatar">AI</div>`;
    row.appendChild(card);

    const welcome = chatMessages.querySelector(".welcome-msg");
    if (welcome) welcome.remove();
    chatMessages.appendChild(row);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    activeReviewCard = row;

    if (fetchIpBtnEl && ipInputEl) {
        fetchIpBtnEl.addEventListener("click", async () => {
            fetchIpBtnEl.disabled = true;
            const originalText = fetchIpBtnEl.textContent;
            fetchIpBtnEl.textContent = "Fetching…";
            try {
                const res = await fetch("/api/proxy/res-ip/allocate", {
                    method: "POST",
                    body: JSON.stringify({ hostname: "" }),
                    headers: { "Content-Type": "application/json" },
                });
                const data = await res.json();
                const freeIps =  data.ip;
                if (data.status !== "success") {
                    throw new Error(data.message || "No free IPs available");
                }
                ipInputEl.value = freeIps;
            } catch (err) {
                addMessage("error", `IP fetch failed: ${err.message}`);
            } finally {
                fetchIpBtnEl.disabled = false;
                fetchIpBtnEl.textContent = originalText;
            }
        });
    }

    deployBtn.addEventListener("click", async () => {
        deployBtn.disabled = true;
        deployBtn.textContent = "Deploying…";
        const formData = {};
        card.querySelectorAll("input[data-key], select[data-key]").forEach((el) => {
            formData[el.dataset.key] = el.dataset.key === "power_on" ? el.value === "true" : el.value;
        });
        formData.ip_allocation_mode = formData.ip_address ? "MANUAL" : "DHCP";
        try {
            const res = await apiPost("/api/confirm_create", { room_id: roomId, form: formData });
            row.remove();
            activeReviewCard = null;
            pendingForm = null;
            addMessage("assistant", res.message || "VM creation submitted.");
            addMessage("assistant", `VM IP Address: ${formData.ip_address || "N/A (DHCP)"}`);
            addPasswordMessage("assistant", "Default Credentials", "root", "Password1!");
            
            // Only show ILM URL if setup_ilm is enabled
            if (formData.setup_ilm === "true" || formData.setup_ilm === true) {
                addLinkMessage("assistant", "ILM Login URL", `http://${formData.ip_address || "N/A"}:9888/ilm/`);
                addPasswordMessage("assistant", "ILM Default Credentials", "admin", "novell@123");
            }
            if (!res.result || res.result.status !== "error") setTimeout(loadVms, 3000);
        } catch (err) {
            addMessage("error", `Deploy failed: ${err.message}`);
            deployBtn.disabled = false;
            deployBtn.textContent = "Deploy VM";
        }
    });

    cancelBtn.addEventListener("click", () => {
        row.remove();
        activeReviewCard = null;
        pendingForm = null;
        addMessage("system", "VM creation cancelled.");
    });
}

// ── Sidebar Create VM form ─────────────────────────────────────────────
createVmForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!roomId) return;

    setCreateStatus("", "");
    const fd = new FormData(createVmForm);
    const form = {
        vm_name:           fd.get("vm_name").trim(),
        template_id:       fd.get("template_id").trim(),
        network_name:      fd.get("network_name").trim(),
        ip_address:        fd.get("ip_address").trim(),
        ip_allocation_mode: "DHCP",
        gateway:           "",
        dns_servers:       "",
        power_on:          fd.get("power_on") === "true",
        storage_profile_id: "",
        compute_policy_id:  "",
    };
    if (form.ip_address) {
        form.ip_allocation_mode = "MANUAL";
    }

    const submitBtn = createVmForm.querySelector("button[type=submit]");
    submitBtn.disabled = true;
    submitBtn.textContent = "Deploying…";
    setCreateStatus("Deploying VM…", "");

    try {
        const res = await apiPost("/api/confirm_create", { room_id: roomId, form });
        setCreateStatus(res.message || "VM deployed!", "success");
        addMessage("assistant", res.message || `VM "${form.vm_name}" creation submitted.`);
        addMessage("assistant", `VM IP Address: ${form.ip_address || "N/A (DHCP)"}`);
        addPasswordMessage("assistant", "Default Credentials", "root", "(as per template)");
        
        // Only show ILM URL if setup_ilm is enabled (sidebar form doesn't have this option by default)
        if (form.setup_ilm === "true" || form.setup_ilm === true) {
            addLinkMessage("assistant", "ILM Login URL", `http://${form.ip_address || "N/A"}:9888/ilm/`);
            addPasswordMessage("assistant", "ILM Default Credentials", "admin", "admin");
        }
        createVmForm.reset();
        setTimeout(loadVms, 3000);
    } catch (err) {
        setCreateStatus(`Error: ${err.message}`, "error");
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "Deploy VM";
    }
});

if (fetchFreeIpBtn) {
    fetchFreeIpBtn.addEventListener("click", async () => {
        const ipInput = createVmForm.querySelector("input[name=ip_address]");
        const vmNameInput = createVmForm.querySelector("input[name=vm_name]");
        const vmName = vmNameInput ? vmNameInput.value.trim() : "";

        fetchFreeIpBtn.disabled = true;
        const originalText = fetchFreeIpBtn.textContent;
        fetchFreeIpBtn.textContent = "Fetching…";
        setCreateStatus("Fetching a free IP…", "");

        try {
            const res = await fetch("/api/proxy/res-ip/allocate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ hostname: vmName }),
            });
            const data = await res.json();
            if (!res.ok || data.status !== "success" || !data.allocated_ip) {
                throw new Error(data.message || "No free IPs available");
            }
            if (ipInput) ipInput.value = data.allocated_ip;
            setCreateStatus(`Allocated IP ${data.allocated_ip}.`, "success");
        } catch (err) {
            setCreateStatus(`Error: ${err.message}`, "error");
        } finally {
            fetchFreeIpBtn.disabled = false;
            fetchFreeIpBtn.textContent = originalText;
        }
    });
}

function setCreateStatus(msg, cls) {
    createStatus.textContent = msg;
    createStatus.className = `create-status ${cls}`;
}

// ── Helpers ────────────────────────────────────────────────────────────
function esc(str) {
    return String(str ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function addPasswordMessage(role, label, username, password) {
    const welcome = chatMessages.querySelector(".welcome-msg");
    if (welcome) welcome.remove();

    const row = document.createElement("div");
    row.className = `msg-row ${role}`;

    const avatarText = role === "user" ? "You" : role === "system" ? "ℹ" : "AI";
    const passwordId = `pwd-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    const bubble = document.createElement("div");
    bubble.className = "msg-bubble";
    bubble.style.display = "flex";
    bubble.style.alignItems = "center";
    bubble.style.gap = "8px";
    
    const textSpan = document.createElement("span");
    textSpan.innerHTML = `${esc(label)} - Username: ${esc(username)} | Password: `;
    
    const passwordSpan = document.createElement("span");
    passwordSpan.id = passwordId;
    passwordSpan.textContent = "••••••••";
    passwordSpan.dataset.hidden = "true";
    passwordSpan.dataset.password = password;
    passwordSpan.style.fontFamily = "monospace";
    
    const eyeBtn = document.createElement("button");
    eyeBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
        <circle cx="12" cy="12" r="3"></circle>
    </svg>`;
    eyeBtn.style.background = "none";
    eyeBtn.style.border = "none";
    eyeBtn.style.cursor = "pointer";
    eyeBtn.style.padding = "4px";
    eyeBtn.style.display = "inline-flex";
    eyeBtn.style.alignItems = "center";
    eyeBtn.style.opacity = "0.7";
    eyeBtn.style.transition = "opacity 0.2s";
    eyeBtn.title = "Toggle password visibility";
    
    eyeBtn.addEventListener("mouseenter", () => eyeBtn.style.opacity = "1");
    eyeBtn.addEventListener("mouseleave", () => eyeBtn.style.opacity = "0.7");
    eyeBtn.addEventListener("click", () => {
        const pwdSpan = document.getElementById(passwordId);
        const isHidden = pwdSpan.dataset.hidden === "true";
        
        if (isHidden) {
            pwdSpan.textContent = pwdSpan.dataset.password;
            pwdSpan.dataset.hidden = "false";
            eyeBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
                <line x1="1" y1="1" x2="23" y2="23"></line>
            </svg>`;
        } else {
            pwdSpan.textContent = "••••••••";
            pwdSpan.dataset.hidden = "true";
            eyeBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                <circle cx="12" cy="12" r="3"></circle>
            </svg>`;
        }
    });
    
    textSpan.appendChild(passwordSpan);
    bubble.appendChild(textSpan);
    bubble.appendChild(eyeBtn);
    
    row.innerHTML = `<div class="msg-avatar">${avatarText}</div>`;
    row.appendChild(bubble);

    chatMessages.appendChild(row);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return row;
}

function addLinkMessage(role, label, url) {
    const welcome = chatMessages.querySelector(".welcome-msg");
    if (welcome) welcome.remove();

    const row = document.createElement("div");
    row.className = `msg-row ${role}`;

    const avatarText = role === "user" ? "You" : role === "system" ? "ℹ" : "AI";
    
    const bubble = document.createElement("div");
    bubble.className = "msg-bubble";
    
    const textSpan = document.createElement("span");
    textSpan.innerHTML = `${esc(label)}: `;
    
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = url;
    link.style.color = "#4a9eff";
    link.style.textDecoration = "underline";
    link.style.wordBreak = "break-all";
    
    textSpan.appendChild(link);
    bubble.appendChild(textSpan);
    
    row.innerHTML = `<div class="msg-avatar">${avatarText}</div>`;
    row.appendChild(bubble);

    chatMessages.appendChild(row);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return row;
}

