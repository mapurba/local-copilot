/**
 * app.js — Chat UI Frontend
 *
 * Handles:
 *  - Loading models and populating the selector
 *  - Sending messages via POST /api/chat/stream (SSE)
 *  - Rendering message bubbles (user / assistant)
 *  - Rendering tool call cards (collapsible, shows name + args + result)
 *  - Tools panel listing all available tools
 */

// ── DOM refs ─────────────────────────────────────────────────────────────────
const modelSelect   = document.getElementById('model-select');
const alwaysAllowEl = document.getElementById('always-allow');
const userInput     = document.getElementById('user-input');
const btnSend       = document.getElementById('btn-send');
const messagesEl    = document.getElementById('messages');
const statusBar     = document.getElementById('status-bar');
const btnTools      = document.getElementById('btn-tools');
const toolsPanel    = document.getElementById('tools-panel');
const btnCloseTools = document.getElementById('btn-close-tools');
const toolsList     = document.getElementById('tools-list');
const overlay       = document.getElementById('overlay');

// ── State ─────────────────────────────────────────────────────────────────────
/** @type {{ role: 'user'|'assistant', content: string }[]} */
const history = [];

/** Currently active tool cards keyed by tool name */
const activeToolCards = new Map();

// ── Init ──────────────────────────────────────────────────────────────────────
loadModels();
loadTools();

// ── Model loading ─────────────────────────────────────────────────────────────
async function loadModels() {
  try {
    const res    = await fetch('/api/models');
    const { models } = await res.json();
    modelSelect.innerHTML = models.map((m) => `<option value="${m}"${m === 'gpt-4.1' ? ' selected' : ''}>${m}</option>`).join('');
    modelSelect.disabled  = false;
    setStatus(`${models.length} models loaded`);
  } catch (err) {
    modelSelect.innerHTML = '<option value="gpt-4.1">gpt-4.1</option>';
    modelSelect.disabled  = false;
    setStatus('Could not fetch model list — using gpt-4.1', 'warn');
  }
}

// ── Tools panel ───────────────────────────────────────────────────────────────
async function loadTools() {
  try {
    const res   = await fetch('/api/tools');
    const { tools } = await res.json();

    // Group by category
    const byCategory = {};
    for (const t of tools) {
      if (!byCategory[t.category]) byCategory[t.category] = [];
      byCategory[t.category].push(t);
    }

    toolsList.innerHTML = Object.entries(byCategory).map(([cat, catTools]) => `
      <h3 style="font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;color:var(--text-dim);margin:8px 0 4px">${cat}</h3>
      ${catTools.map((t) => `
        <div class="tool-item">
          <div class="tool-item-name">${t.name}</div>
          <div class="tool-item-desc">${t.description}</div>
        </div>
      `).join('')}
    `).join('');
  } catch (err) {
    toolsList.innerHTML = '<p style="color:var(--text-dim);padding:12px">Could not load tools</p>';
  }
}

btnTools.addEventListener('click', () => {
  toolsPanel.classList.remove('hidden');
  overlay.classList.remove('hidden');
});
btnCloseTools.addEventListener('click', closePanel);
overlay.addEventListener('click', closePanel);
function closePanel() {
  toolsPanel.classList.add('hidden');
  overlay.classList.add('hidden');
}

// ── Send message ──────────────────────────────────────────────────────────────
userInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
btnSend.addEventListener('click', sendMessage);

// Auto-grow textarea
userInput.addEventListener('input', () => {
  userInput.style.height = 'auto';
  userInput.style.height = Math.min(userInput.scrollHeight, 200) + 'px';
});

async function sendMessage() {
  const text = userInput.value.trim();
  if (!text || btnSend.disabled) return;

  // Clear input & reset height
  userInput.value = '';
  userInput.style.height = 'auto';

  // Remove welcome banner
  const welcome = messagesEl.querySelector('.welcome');
  if (welcome) welcome.remove();

  // Add user message to history and UI
  history.push({ role: 'user', content: text });
  appendMessage('user', text);

  // Disable input while streaming
  setInputEnabled(false);
  setStatus('Thinking…');

  // Create placeholder for assistant response
  const assistantBubble = appendMessage('assistant', '');
  assistantBubble.bubble.classList.add('streaming');

  // Track tool cards for this response
  activeToolCards.clear();

  try {
    const res = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelSelect.value, messages: history, alwaysAllow: alwaysAllowEl.checked }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }

    let fullContent = '';
    const reader    = res.body.getReader();
    const decoder   = new TextDecoder();
    let   buffer    = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE lines are separated by double newline
      const events = buffer.split('\n\n');
      buffer = events.pop(); // last (possibly incomplete) chunk

      for (const event of events) {
        const line = event.trim();
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        let parsed;
        try { parsed = JSON.parse(raw); } catch { continue; }

        const { type, text } = parsed;

        if (type === 'content') {
          fullContent += text;
          assistantBubble.bubble.innerHTML = marked.parse(fullContent);
          scrollToBottom();
        } else if (type === 'approval') {
          handleApprovalChunk(assistantBubble.el, text);
        } else if (type === 'tool') {
          handleToolChunk(assistantBubble.el, text);
        } else if (type === 'thinking') {
          handleThinking(text);
        } else if (type === 'usage') {
          handleUsage(text);
        } else if (type === 'done') {
          // finished
        } else if (type === 'error') {
          throw new Error(text);
        }
      }
    }

    assistantBubble.bubble.classList.remove('streaming');

    // Add to history
    history.push({ role: 'assistant', content: fullContent });
    setStatus('');

  } catch (err) {
    assistantBubble.bubble.classList.remove('streaming');
    assistantBubble.bubble.innerHTML = `<span style="color:#f85149">⚠ Error: ${escHtml(err.message)}</span>`;
    assistantBubble.bubble.style.borderColor = '#f85149';
    setStatus(`Error: ${err.message}`, 'error');
  } finally {
    setInputEnabled(true);
    userInput.focus();
  }
}

// ── Approval card (human-in-the-loop) ───────────────────────────────────────
/**
 * Renders a card with Allow / Deny buttons when the LLM requests a tool call
 * and "Always allow tools" is unchecked. Clicking a button POSTs to
 * /api/chat/approve so the server can resume the agent loop.
 */
function handleApprovalChunk(parentEl, text) {
  let event;
  try { event = JSON.parse(text); } catch { return; }
  const { approvalId, name, args } = event;

  const card = document.createElement('div');
  card.className = 'approval-card';
  card.innerHTML = `
    <div class="approval-header">
      <span class="approval-icon">⚠️</span>
      <span class="approval-title">Tool approval required</span>
      <span class="approval-name">${escHtml(name)}</span>
    </div>
    <div class="approval-args">${escHtml(JSON.stringify(args, null, 2))}</div>
    <div class="approval-btns">
      <button class="btn-allow">✓ Allow</button>
      <button class="btn-deny">✕ Deny</button>
    </div>
  `;

  async function resolve(approved) {
    // Disable buttons immediately
    card.querySelectorAll('button').forEach((b) => (b.disabled = true));
    const btnsEl = card.querySelector('.approval-btns');
    const verdict = document.createElement('div');
    verdict.className = `approval-verdict ${approved ? 'allowed' : 'denied'}`;
    verdict.textContent = approved ? '✓ Allowed' : '✕ Denied';
    btnsEl.replaceWith(verdict);
    card.classList.add('resolved');

    await fetch('/api/chat/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approvalId, approved }),
    });
  }

  card.querySelector('.btn-allow').addEventListener('click', () => resolve(true));
  card.querySelector('.btn-deny').addEventListener('click',  () => resolve(false));

  parentEl.appendChild(card);
  setStatus(`⚠️ Waiting for approval: ${name}`);
  scrollToBottom();
}

// ── Tool card rendering ───────────────────────────────────────────────────────
function handleToolChunk(parentEl, text) {
  let event;
  try { event = JSON.parse(text); } catch { return; }

  const { phase, name, args, result } = event;

  if (phase === 'start') {
    const card = createToolCard(name, args);
    parentEl.appendChild(card.el);
    activeToolCards.set(name, card);
    setStatus(`Running tool: ${name}…`);
    scrollToBottom();
  } else if (phase === 'denied') {
    // Tool was denied — show a compact denied badge instead of a full card
    const denied = document.createElement('div');
    denied.style.cssText = 'font-size:.8rem;color:#f85149;padding:4px 0;font-family:var(--mono)';
    denied.textContent = `✕ ${name} — denied by user`;
    parentEl.appendChild(denied);
    scrollToBottom();
  } else if (phase === 'result') {
    const card = activeToolCards.get(name);
    if (card) {
      card.setResult(result);
    }
    setStatus('');
    scrollToBottom();
  }
}

function createToolCard(name, args) {
  const el = document.createElement('div');
  el.className = 'tool-card';

  const header = document.createElement('div');
  header.className = 'tool-header';

  const nameEl  = document.createElement('span');
  nameEl.className = 'tool-name';
  nameEl.textContent = name;

  const badge   = document.createElement('span');
  badge.className = 'tool-badge running';
  badge.textContent = 'running';

  const toggle  = document.createElement('span');
  toggle.className = 'tool-toggle';
  toggle.textContent = '▼ details';

  header.append(nameEl, badge, toggle);

  const body    = document.createElement('div');
  body.className = 'tool-body';
  body.innerHTML = `
    <div class="tool-section">
      <strong>Arguments</strong>
      <pre>${escHtml(JSON.stringify(args, null, 2))}</pre>
    </div>
    <div class="tool-section result-section" style="display:none">
      <strong>Result</strong>
      <pre class="result-pre"></pre>
    </div>
  `;

  header.addEventListener('click', () => {
    body.classList.toggle('open');
    toggle.textContent = body.classList.contains('open') ? '▲ hide' : '▼ details';
  });

  el.append(header, body);

  return {
    el,
    setResult(result) {
      badge.className    = 'tool-badge done';
      badge.textContent  = 'done';
      const section = body.querySelector('.result-section');
      const pre     = body.querySelector('.result-pre');
      section.style.display = '';
      pre.textContent = JSON.stringify(result, null, 2);
      // Auto-open body on first result so people see it
      if (!body.classList.contains('open')) {
        body.classList.add('open');
        toggle.textContent = '▲ hide';
      }
    },
  };
}

// ── Thinking / usage ──────────────────────────────────────────────────────────
function handleThinking(text) {
  try {
    const obj = JSON.parse(text);
    if (obj.node === 'tools' && obj.tools) {
      setStatus(`Using tools: ${obj.tools.join(', ')}`);
    } else if (obj.node === 'agent') {
      setStatus('Agent thinking…');
    }
  } catch { /* plain text */ }
}

function handleUsage(text) {
  try {
    const { promptTokens, completionTokens, totalTokens } = JSON.parse(text);
    if (totalTokens != null) {
      setStatus(`Tokens used — prompt: ${promptTokens}, completion: ${completionTokens}, total: ${totalTokens}`);
    }
  } catch { /* ignore */ }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function appendMessage(role, content) {
  const el     = document.createElement('div');
  el.className = `msg ${role}`;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = content;

  const meta   = document.createElement('div');
  meta.className = 'msg-meta';
  meta.textContent = role === 'user' ? 'You' : 'Assistant';

  el.append(meta, bubble);
  messagesEl.appendChild(el);
  scrollToBottom();
  return { el, bubble };
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function setInputEnabled(enabled) {
  btnSend.disabled    = !enabled;
  userInput.disabled  = !enabled;
}

function setStatus(msg, level = 'info') {
  statusBar.textContent = msg;
  statusBar.style.color = level === 'error' ? '#f85149' : level === 'warn' ? '#d29922' : 'var(--text-dim)';
}

function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
