# 🎤 Speaker Notes — How to Build Custom AI Agents

> **Keep this open on a second screen. Glance, don't read.**  
> Each block = one beat. ✅ = run something live. 💬 = say this out loud.

---

## 🚀 Opening Encouragement  *(read this aloud as your very first words)*

💬 **"Raise your hand if you've used ChatGPT or Copilot."**

*Wait for hands. Almost everyone.*

💬 **"Now keep your hand up if you've ever thought — 'this is cool, but I wish it could actually *do* something in my environment. SSH into my server. Check my git. Run a command. Not just talk about it.'"**

*Hands stay up.*

💬 **"That gap — between a chatbot that talks and an agent that acts — is exactly what we're closing today."**

*Pause.*

💬 **"And here's the thing nobody tells you: it's not hard. It's not a research project. It's not a six-month roadmap item. The mental model fits on a napkin. The code fits in one file. I know, because you're holding it right now — and by the end of this session, you will have run it, broken it, and understood every line."**

💬 **"So — no slides, no theory. Just a terminal, a browser, and 57 tools waiting to be pointed at something interesting. Let's go."**

---

## OPEN  *(before you say anything, open http://localhost:3000)*

💬 **"What if your app could SSH into a server, check disk space, read a git diff, and explain what it found — just from a plain English sentence? That's what we're building today."**

*Pause. Let it land. Then:*

💬 **"Not theory. Running code. You'll have it working by the end."**

---

## BEAT 1 · What is an agent?  `5 min`

Draw / show this:

```
"Check disk space on the prod server"
        ↓
      [LLM]  ←──────────────────────────┐
        │                                │
     tool_calls?                         │
        │ YES                            │
        ↓                                │
    [ssh_run "df -h"]                    │
        │                                │
      result ──── fed back ─────────────┘
        │ NO more tools
        ↓
   "Root partition is 73% full."
```

💬 **"LLM = brain. Tools = hands. Loop = the magic glue."**

> ⚠️ **Don't go deeper here.** The code will explain the rest. Move on.

---

## BEAT 2 · Simple chat  `8 min`

✅ `node workshop/01-simple-chat.js`

Point at three things only:

1. **Messages array** → *"This is the memory. No database. Just an array."*
2. **invoke()** → *"Whole reply at once."*
3. **stream()** → *"Token by token — this is what makes it feel alive."*

💬 **"History IS memory. Want it to remember something? Push it into the array."**

> ⚠️ If someone asks about RAG / vector DBs — *"Great topic, parking it — that's session 2."*

---

## BEAT 3 · Tool calling  `10 min`

✅ `node workshop/02-tool-calling.js`

Show the two-part structure:

```js
// PART 1 — what the LLM sees (just text)
{ name: 'add', description: 'Add two numbers.' }

// PART 2 — what actually runs (your code)
function add({ a, b }) { return { result: a + b }; }
```

💬 **"The LLM never sees your implementation. It reads the description and decides when to call it. Good description = reliable agent. Vague description = chaos."**

Then show the dance:
1. LLM returns `tool_calls` (not text)
2. You run the function
3. You wrap result in `ToolMessage`
4. LLM reads it, continues

> ⚠️ **Don't explain JSON Schema in depth.** One sentence: *"It's just a shape — tell the LLM what arguments to pass."*

---

## BEAT 4 · LangGraph  `12 min`

✅ `node workshop/03-langgraph-agent.js`

Draw the graph — **do this before showing code:**

```
START → [agent] → has tool_calls? → YES → [tools] ──┐
             ↓                                        │
             NO                                       │
             ↓                          ←────────────┘
            END
```

💬 **"The graph IS the agent. If you want to add a safety review step — add a node. Logging? Add a node. Multi-agent hand-off? Add a node."**

Three things to show in code:
1. `Annotation.Root` — *"Shared state. Append-only messages."*
2. `addConditionalEdges` — *"This is the router. Tools or done?"*
3. `graph.stream()` — *"Watch each node fire in order."*

> ⚠️ Don't get into `checkpointers` or persistence — *"Out of scope today."*

---

## BEAT 5 · Human in the loop  `8 min`

✅ `node workshop/04-human-in-loop.js`

💬 **"Would you give an AI unrestricted shell access to production? Me neither."**

Show the one callback that does everything:

```js
async function onApproval({ name, args }) {
  // fires BEFORE every tool call
  // return true → proceed, false → deny
}
```

**Demo live:** ask two things, approve one, deny the other.

💬 **"In CI/CD you'd replace readline with a Slack message. Same pattern."**

> ⚠️ If someone asks "what if the agent loops forever?" — *"Great — that's where the 5-minute timeout comes in. We have one."*

---

## BEAT 6 · Real infrastructure  `10 min`

### SSH  *(~5 min)*

✅ `node workshop/05-ssh-agent.js`

💬 **"Same pattern. The tool just happens to open an SSH tunnel."**

Point out:
- Session is **persisted** — connects once, reuses for every command
- LLM decides which command to run — you just describe the tool

Ask the room: *"What would you ask an agent with SSH access to all your VMs?"*

> ⚠️ Don't live-edit credentials. They're in `.env`.

### Git  *(~5 min)*

✅ `node workshop/06-git-agent.js`

💬 **"The agent answered 'what changed' by passing `HEAD~1` to git diff. It just knows the flag."**

Point out: these are the **real** `src/tools/git.js` functions — not workshop toys.

---

## BEAT 7 · Live UI demo  `5 min`

Open http://localhost:3000. Run these **in this order:**

| Type this | Shows this |
|-----------|-----------|
| `Connect to 10.71.33.24 and show disk usage` | SSH + tool card |
| `List running Docker containers` | Session reuse |
| `Last 3 commits in this repo?` | Git tool |
| `Solve 3x² - 5x + 2 = 0` | Math tool |

Point at the UI:
- 🟡 **running** badge → 🟢 **done** badge
- Tool card expandable — *"Nothing is hidden"*
- Markdown table rendered from raw stdout

💬 **"Everything you just saw was the same loop you read in the workshop files — just with a web skin on top."**

---

## CLOSE  `2 min`

💬 **Five things to remember:**

1. Agent = LLM + tools + loop
2. Description is the interface — write it like docs
3. Session = a Map. That's it.
4. Human-in-the-loop = one callback
5. This scales from a calculator to full DevOps automation

💬 **"You now have 57 tools, SSH access, Git integration, and a web UI. The only question left is: what do you point it at?"**

*Open to Q&A.*

---

## 🆘 Emergency resets

| Thing going wrong | Fix |
|---|---|
| Server not running | `node server.js` |
| SSH won't connect | Check `.env` → `SSH_HOST`, `SSH_PASSWORD` |
| Token expired | Re-copy `COPILOT_TOKEN` to `.env`, restart server |
| Someone asks something deep | *"Great question — let's take that offline / session 2"* |
| You lose your place | Look at the **Agenda** below |

---

## 🗺 Agenda  *(your anchor — come back here if you drift)*

```
1. What is an agent?          5 min   ← mental model only
2. Simple chat                8 min   ← 01-simple-chat.js
3. Tool calling              10 min   ← 02-tool-calling.js
4. LangGraph                 12 min   ← 03-langgraph-agent.js
5. Human in the loop          8 min   ← 04-human-in-loop.js
6. SSH + Git                 10 min   ← 05 + 06
7. Web UI demo                5 min   ← localhost:3000
Q&A                          15 min
──────────────────────────────────────
TOTAL                        73 min
```

> If you're running long, **skip Beat 6** (SSH/Git) and go straight to the UI demo.  
> If you're running short, **slow down Beat 4** (LangGraph) — that's the richest content.
