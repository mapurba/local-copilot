# 🤖 How to Build Custom AI Agents
### Brownbag Session — Facilitator Script

> **Format:** 60 min interactive session + 15 min Q&A  
> **Audience:** Developers with basic JS/Python knowledge, no LLM experience required  
> **Repo:** `git clone <your-repo>` → `npm install` → `cp .env.example .env` (add your token)  
> **Before you start:** `node server.js` → open http://localhost:3000

---

## ⚡ The Pitch  *(1 min — say this first)*

> *"What if your app could figure out what to do by itself — call an API, check a file, SSH into a server, run a git command — all from a plain English instruction? That's what an AI agent is. Today we're going to build one from scratch, understand exactly how it works, and see it talk to real infrastructure."*

---

## 🗺 Agenda at a Glance

| # | Topic | Time | File |
|---|-------|------|------|
| 1 | The mental model — what IS an agent? | 5 min | — |
| 2 | Chat fundamentals | 8 min | `01-simple-chat.js` |
| 3 | Giving the LLM tools | 10 min | `02-tool-calling.js` |
| 4 | LangGraph — the agent loop | 12 min | `03-langgraph-agent.js` |
| 5 | Safety — human in the loop | 8 min | `04-human-in-loop.js` |
| 6 | Real infrastructure — SSH & Git | 10 min | `05-ssh-agent.js` / `06-git-agent.js` |
| 7 | Live demo on the web UI | 5 min | http://localhost:3000 |
| Q&A | | 15 min | — |

---

## 1 · The Mental Model  *(5 min)*

Draw this on a whiteboard or share your screen:

```
┌─────────────────────────────────────────────────────┐
│                    AGENT LOOP                        │
│                                                      │
│   "Check disk space on 10.71.33.24"                 │
│          │                                           │
│          ▼                                           │
│       [LLM] ──── wants a tool? ──YES──► [Tool runs] │
│          │                                    │      │
│          │        ◄───────── result ──────────┘      │
│          │                                           │
│          └──NO──► "Disk is 73% full on /dev/sda1"   │
└─────────────────────────────────────────────────────┘
```

**Three things to make this click:**

1. **The LLM is the brain** — it reads your message, decides what to do, picks tools, and writes the final answer. It never "runs" anything itself.

2. **Tools are the hands** — they do real things: HTTP calls, shell commands, file reads. A tool is just a function with a name and a description.

3. **The loop is just a while loop** — keep asking the LLM "are you done?" until it stops requesting tools.

> 💬 *"The magic isn't the LLM — it's the loop. The LLM is surprisingly good at knowing which function to call and in what order. You just have to describe the functions in plain English."*

---

## 2 · Chat Fundamentals  *(8 min)*

**Run:** `node workshop/01-simple-chat.js`

The three things everyone needs to understand:

```js
// 1. Message types — this IS the conversation history
new SystemMessage('You are a helpful assistant.')  // Instructions
new HumanMessage('What is 2 + 2?')                // User turn
new AIMessage('2 + 2 equals 4.')                   // LLM turn

// 2. invoke() — wait for the whole reply
const response = await llm.invoke([systemMsg, humanMsg]);
console.log(response.content);   // "2 + 2 equals 4."

// 3. stream() — get tokens as they arrive
for await (const chunk of await llm.stream([...])) {
  process.stdout.write(chunk.content);  // prints token-by-token
}
```

> 💬 *"Memory in an LLM is literally just the messages array. There's no database. You want the LLM to remember something? Put it in the array."*

**Show the audience:** add a second `HumanMessage` that refers to the first reply — the LLM remembers.

---

## 3 · Giving the LLM Tools  *(10 min)*

**Run:** `node workshop/02-tool-calling.js`

This is where it gets interesting. Tools have two parts:

```js
// Part 1: The description (what the LLM sees)
{
  type: 'function',
  function: {
    name: 'get_server_uptime',
    description: 'Get how long a server has been running.',  // ← LLM reads this
    parameters: {
      type: 'object',
      required: ['host'],
      properties: { host: { type: 'string' } }
    }
  }
}

// Part 2: The implementation (what actually runs)
function get_server_uptime({ host }) {
  return { uptime: '14 days, 3 hours' };  // in reality: SSH or API call
}
```

**The three-step dance:**

```
1. You: "How long has 10.71.33.24 been up?"

2. LLM: "I'll call get_server_uptime({ host: '10.71.33.24' })"
   response.tool_calls = [{ name: 'get_server_uptime', args: {...} }]

3. You: run the function, wrap result in ToolMessage, send back to LLM

4. LLM: "The server at 10.71.33.24 has been up for 14 days."
```

> 💬 *"Notice the LLM never sees your function code — only the description. Good descriptions = reliable tool use. Vague descriptions = hallucinated arguments."*

**Key insight to share:** The LLM can chain tools. Ask it something that requires 3 steps — it'll call them in order automatically.

---

## 4 · LangGraph — Making It Production-Ready  *(12 min)*

**Run:** `node workshop/03-langgraph-agent.js`

The manual `while(true)` loop works, but LangGraph gives you:
- ✅ State that flows between steps
- ✅ Built-in streaming per node
- ✅ Visual graph you can inspect and test
- ✅ Foundation for multi-agent systems

```js
// State = the shared blackboard every node reads and writes to
const AgentState = Annotation.Root({
  messages: Annotation({
    reducer: (existing, newMsgs) => existing.concat(newMsgs),  // append-only
    default: () => [],
  }),
});

// Two nodes: the LLM call and the tool execution
const graph = new StateGraph(AgentState)
  .addNode('agent', agentNode)        // calls LLM, emits text or tool_calls
  .addNode('tools', toolsNode)        // runs tool_calls, emits ToolMessages
  .addEdge(START, 'agent')
  .addConditionalEdges('agent', shouldContinue)   // tools? or END?
  .addEdge('tools', 'agent')          // always loop back
  .compile();
```

Draw this graph — it makes everything tangible:

```
START ──► [agent] ──has tool_calls?──YES──► [tools] ──┐
              │                                         │
              └──NO──► END          ◄───────────────────┘
```

> 💬 *"The graph IS the agent. Want to add a memory node that summarises old messages? Add a node. Want a reviewer node that checks outputs for safety? Add a node. This is the power of LangGraph."*

---

## 5 · Safety — Human in the Loop  *(8 min)*

**Run:** `node workshop/04-human-in-loop.js`

> 💬 *"Would you give an AI agent unrestricted shell access to production without a confirmation step? Me neither. Here's how to add one."*

The entire pattern is one callback:

```js
async function onApproval({ name, args }) {
  // This runs BEFORE the tool executes
  console.log(`Agent wants to call: ${name}(${JSON.stringify(args)})`);
  const answer = await askUser('Allow? (y/n) ');
  return answer.toLowerCase() === 'y';   // true = proceed, false = deny
}
```

The agent loop pauses here. When the user types `y`, execution resumes. `n` sends a "denied" ToolMessage back — the LLM sees it and explains why it couldn't proceed.

**Demo:** ask the agent to do two things. Approve one, deny the other. Watch how it handles both.

> 💬 *"The same callback powers the Allow/Deny buttons in the web UI. One pattern, two surfaces. In CI/CD you'd replace the readline with a Slack message or a webhook."*

---

## 6 · Real Infrastructure — SSH & Git  *(10 min)*

This is where it gets exciting for engineers.

### SSH Agent (`05-ssh-agent.js`)

```js
// The TOOL definition (what the LLM sees)
{ name: 'ssh_run', description: 'Run a shell command on the remote host.' }

// The IMPLEMENTATION (uses our production sshTools module)
case 'ssh_run': return sshTools.runCommand(args.command, args.sessionId);
```

**Run it:** `node workshop/05-ssh-agent.js`

Ask the audience: *"What would you ask an agent that has SSH access to all your VMs?"*

Ideas to spark discussion:
- "Which of our servers is running low on disk space?"
- "Are all docker containers healthy across the cluster?"
- "Find any process using more than 80% CPU"

### Git Agent (`06-git-agent.js`)

```js
case 'git_status': return gitTools.getStatus(REPO_PATH);
case 'git_diff':   return gitTools.getDiff(REPO_PATH, args.target ?? '');
```

**Run it:** `node workshop/06-git-agent.js`

> 💬 *"The agent answered 'what changed in the last commit' by calling git_diff with HEAD~1 — a flag you'd have to google if you don't use it daily. The LLM just knows."*

---

## 7 · Live Web UI Demo  *(5 min)*

Switch to http://localhost:3000. Run these prompts live:

| Prompt | What it shows |
|--------|---------------|
| `Connect to 10.71.33.24 and show me disk usage` | SSH session creation + command |
| `Now list all running Docker containers` | Session reuse (no re-auth) |
| `What are the last 3 commits in this repo?` | Git tool use |
| `Solve 3x² - 5x + 2 = 0` | Local math tools |

Point out: the tool cards expanding, the streaming text, the tool badge going from 🟡 running → 🟢 done.

> 💬 *"Every tool card you see is one round trip: LLM decides → tool runs → result feeds back. The whole thing is transparent — nothing is hidden."*

---

## 🔧 How to Build Your Own Tool — 5-Step Recipe

Give this to the audience as a takeaway:

```
Step 1: Pick a thing your system can do
         e.g. "query our internal metrics API"

Step 2: Write the function
         async function getMetrics({ service, window }) { ... }

Step 3: Write the description (this is the hardest part — be specific)
         "Get error rate and p99 latency for a service over a time window.
          window examples: '1h', '24h', '7d'"

Step 4: Register it
         toolRegistry.register('ops:getMetrics', getMetrics, 'ops', description)

Step 5: Ask the agent naturally
         "Is the auth service degraded right now?"
```

---

## ❓ Q&A Prompts  *(to keep it flowing)*

If the room goes quiet, use these:

- *"What tool would be most useful in your team's daily workflow?"*
- *"Where would you add a human-in-the-loop gate in your CI/CD pipeline?"*
- *"What's the difference between an agent and a chatbot?"* (answer: tools + loop)
- *"What could go wrong if the tool descriptions are too vague?"*
- *"How would you test an agent?"* (answer: mock the tools, assert on sequences)

---

## 📋 Pre-Session Setup Checklist

Send this to attendees **1 day before:**

```
✅ Node.js 18+ installed  (node --version)
✅ Clone the repo:  git clone <url>
✅ Install deps:    npm install
✅ Copy env:        cp .env.example .env
✅ Add token:       COPILOT_TOKEN=ghu_xxxx  (or ask organiser)
✅ Start server:    node server.js
✅ Verify:          http://localhost:3000 loads ✓
```

**If the room has no setup time:** just run the server on your machine and share your screen + a `localhost` ngrok tunnel so everyone can follow along interactively.

---

## 💡 Key Takeaways  *(say these at the end)*

1. **An agent = LLM + tools + a loop.** Everything else is just plumbing.
2. **The description IS the interface.** Write it like documentation, not code.
3. **Session persistence is just a Map.** No database needed for short-lived conversations.
4. **Human-in-the-loop is one callback.** Add it anywhere, remove it in trusted contexts.
5. **The same pattern scales from calculator tools to full DevOps automation.**

> *"You now have a running agent with 57 tools, SSH access, and Git integration. The next step is: what would you point it at in your own team?"*

---

*Workshop files: `workshop/01` → `06` · Server: `node server.js` · UI: http://localhost:3000*
