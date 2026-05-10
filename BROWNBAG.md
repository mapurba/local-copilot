# AI Agent Brownbag — Talk Path

> **Total time:** ~50 min + Q&A  
> **Repo:** `d:\gitlab\local-copilot`  
> **Run server before you start:** `node server.js`  
> **Open browser:** http://localhost:3000

---

## 0 · Setup check  *(2 min, before people arrive)*

```bash
node server.js          # should print 🚀 AI Agent Demo running at http://localhost:3000
```

- Browser tab open at http://localhost:3000
- VSCode open with `src/copilotApi.js` and `examples/` side by side
- `.env` has `COPILOT_TOKEN` set

---

## 1 · The Big Picture  *(5 min)*

> "We're going to build an AI agent from scratch — one that can read files, run commands, call APIs, do maths, and ask you before it does anything dangerous."

Draw on whiteboard (or paste this):

```
User message
    │
    ▼
[LLM] ──── wants a tool? ──YES──► [Tool runs] ──► back to LLM
    │                                                    ↑
    └──NO──► final reply                                 │
                                            (loops until done)
```

Key points:
- LLM is the brain — it decides what to do
- Tools are the hands — they do real things
- LangGraph manages the loop
- We use **GitHub Copilot** as the LLM (no OpenAI account needed)

---

## 2 · Auth — `tokenManager.js`  *(3 min)*

Open `src/tokenManager.js`.

```
GITHUB_TOKEN (ghu_xxx, short OAuth token)
    │
    ▼
api.github.com/copilot_internal/v2/token
    │
    ▼
Copilot JWT (long token, valid 30 min)
    │
    ▼
api.githubcopilot.com/chat/completions
```

Show: cache (`cache`), dedup (`inflight`), `getToken()`.

> "One call, always fresh — the rest of the code never touches auth."

---

## 3 · Example 01 — Simple Chat  *(8 min)*

> "Before agents, let's understand the building block: **ChatOpenAI**."

Open `examples/01-simple-chat.js`. Walk through:

### 3a. Message types
```js
new SystemMessage('...')   // instructions to the LLM
new HumanMessage('...')    // user turn
new AIMessage('...')       // LLM turn (returned, or added to history)
```
> "History IS memory — you just keep appending messages."

### 3b. invoke() vs stream()
```js
const response = await llm.invoke([...messages]);
// response.content = full reply text, arrives all at once

const stream = await llm.stream([...messages]);
for await (const chunk of stream) { process.stdout.write(chunk.content); }
// chunk.content = one fragment, arrives as tokens are generated
```

**Run it:**
```bash
node examples/01-simple-chat.js
```

Point out: multi-turn memory, streaming output, token usage.

---

## 4 · Example 02 — Tool Calling  *(10 min)*

> "Now let's give the LLM tools — and handle the call ourselves."

Open `examples/02-tool-calling.js`. Walk through:

### 4a. Defining a tool (OpenAI function schema)
```js
{
  type: 'function',
  function: {
    name: 'add',
    description: 'Add two numbers',   // ← LLM reads this
    parameters: { ... }               // ← JSON Schema for args
  }
}
```
> "The description is the interface. The LLM decides when to use it."

### 4b. Binding tools
```js
const llmWithTools = llm.bindTools(TOOLS, { tool_choice: 'auto' });
```
> "auto = LLM decides; forced = always call specific tool"

### 4c. The response
```js
const response = await llmWithTools.invoke(messages);
response.tool_calls  // [{ id, name, args }]  ← LLM requesting a tool
response.content     // text, if no tool needed
```

### 4d. ToolMessage — closing the loop
```js
new ToolMessage({ tool_call_id: tc.id, content: JSON.stringify(result) })
```
> "The LLM can't see results unless you feed them back as ToolMessages."

### 4e. The manual loop
Show the `while (true)` in `runWithTools()` — keep going until no more `tool_calls`.

**Run it:**
```bash
node examples/02-tool-calling.js
```

Point out: multi-step math (add then multiply), weather, no-tool fallback.

---

## 5 · Example 03 — LangGraph Agent  *(12 min)*

> "The manual loop is fine, but LangGraph gives us: state management, streaming step-by-step, and a foundation for complex multi-agent systems."

Open `examples/03-langgraph-agent.js`.

### 5a. State — the shared blackboard
```js
const AgentState = Annotation.Root({
  messages: Annotation({
    reducer: (existing, newMessages) => existing.concat(newMessages),
    //        ↑ append-only — never replace, always grow
    default: () => [],
  }),
});
```
> "State flows through every node. Each node reads it, returns a delta, the reducer merges."

### 5b. Nodes — named processing steps
```js
.addNode('agent', agentNode)   // calls the LLM
.addNode('tools', toolsNode)   // runs tool calls
```

### 5c. Edges — the wiring
```js
.addEdge(START, 'agent')                      // fixed: always start at agent
.addConditionalEdges('agent', shouldContinue) // dynamic: tools or END?
.addEdge('tools', 'agent')                    // fixed: always loop back
```

Draw the graph again:
```
START ──► [agent] ──► shouldContinue ──► [tools] ──┐
              │                                      │
              └──► END ◄────────────────────────────┘
                   (no tool calls)
```

### 5d. invoke() vs stream()
```js
// Run to completion, return final state
const result = await graph.invoke({ messages });

// Yield each node's output as it happens
const stream = await graph.stream({ messages }, { streamMode: 'updates' });
for await (const update of stream) {
  const [nodeName, delta] = Object.entries(update)[0];
  // see each step: agent → tools → agent → END
}
```

**Run it:**
```bash
node examples/03-langgraph-agent.js
```

Point out: `stream()` output shows each step, parallel tool calls in Test 1.

---

## 6 · Example 04 — Human in the Loop  *(10 min)*

> "What if you don't want the agent to just run commands on your machine without asking? Human-in-the-loop."

Open `examples/04-human-in-loop.js`.

### 6a. The pattern — one callback
```js
// Before each tool runs, call this:
const approved = await onApproval({ name, args });
if (!approved) {
  // return a "denied" ToolMessage — LLM knows to explain why
}
// else — run the tool normally
```

### 6b. In the terminal example — readline
The `askApproval()` function pauses the agent and waits for `[Y/n]`.

**Run it:**
```bash
node examples/04-human-in-loop.js
```

Try: `"calculate 10 * 20, then reverse the string 'LangGraph'"`  
→ Approve the first, deny the second. Watch the LLM adapt.

### 6c. In the web app — SSE + Promise
Show `server.js` (the approval Map):
```js
const onApproval = ({ id, name, args }) => new Promise((resolve) => {
  const approvalId = randomUUID();
  pendingApprovals.set(approvalId, resolve);  // park the Promise
  send('approval', JSON.stringify({ approvalId, name, args }));  // tell the browser
});
// When browser POSTs /api/chat/approve → pendingApprovals.get(id)(approved) → resumes agent
```

> "The agent loop is just paused at an `await`. SSE sends the question to the browser, a POST brings the answer back."

Show the toggle in the UI header: **Always allow tools** checkbox.

---

## 7 · Live Demo  *(8 min)*

Open http://localhost:3000 in the browser.

### Demo 1 — Tools working (Always Allow ON)
Ask: `"What files are in the current directory?"`  
→ Show the `custom:listDir` tool card expanding with args + result.

Ask: `"Solve 2x² - 3x - 5 = 0"`  
→ Show `custom:mathSolveQuadratic` tool card.

### Demo 2 — Human in the loop (Always Allow OFF)
Uncheck **"Always allow tools"**.  
Ask: `"List the files in the current directory, then read the contents of package.json"`

→ Show the amber approval card for `listDir` — click **Allow**  
→ Show the approval card for `readFile` — click **Deny**  
→ Show the LLM gracefully explaining it couldn't read the file.

---

## 8 · Architecture recap  *(2 min)*

```
.env
  └── COPILOT_TOKEN / GITHUB_TOKEN
        │
        ▼
tokenManager.js          → getToken() — always fresh JWT
        │
        ▼
copilotApi.js
  ├── buildLLM()         → ChatOpenAI pointed at Copilot
  ├── buildOpenAITools() → tool schema (27 tools)
  └── buildAgentGraph()  → LangGraph StateGraph
        │
        ▼
server.js (Express)
  ├── POST /api/chat/stream  → SSE stream to browser
  ├── POST /api/chat/approve → resolve pending approval Promise
  └── GET  /api/tools        → list tools
        │
        ▼
public/
  ├── index.html  → layout + Always Allow toggle
  ├── style.css   → dark theme, approval cards
  └── app.js      → SSE reader, approval cards, tool cards
```

---

## 9 · Q&A prompts  *(open)*

Things likely to come up:

- **"How do I add a new tool?"**  
  → Add a function to the right file in `src/tools/`, call `toolRegistry.register()`. That's it.

- **"Can you use a different LLM?"**  
  → Change `buildLLM()` — swap `ChatOpenAI` for `ChatAnthropic`, `ChatGoogleGenerativeAI`, etc. Same API.

- **"What's the difference between invoke() and stream()?"**  
  → `invoke()` waits for the full result. `stream()` yields deltas as they arrive — better UX, same logic.

- **"Why LangGraph instead of just a while loop?"**  
  → For this demo, a while loop would work. LangGraph adds: checkpointing (resume after crash), parallel branches, multi-agent orchestration, streaming at the graph level.

- **"Is this production ready?"**  
  → The token management is production-grade. The tool sandbox (no permissions, no timeouts beyond 30s) is not. Add rate limiting, auth middleware, input validation for real use.

---

## Files to keep open during talk

| Step | File |
|------|------|
| 2    | `src/tokenManager.js` |
| 3    | `examples/01-simple-chat.js` |
| 4    | `examples/02-tool-calling.js` |
| 5    | `examples/03-langgraph-agent.js` |
| 6    | `examples/04-human-in-loop.js`, `server.js` (approval section) |
| 7    | Browser at http://localhost:3000 |
