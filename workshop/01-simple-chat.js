/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Example 01 — Simple Chat  (LangChain, no tools, no agent loop)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Concepts shown:
 *   • ChatOpenAI  — the LangChain wrapper around OpenAI-compatible APIs
 *   • Message types — SystemMessage, HumanMessage, AIMessage
 *   • llm.invoke()  — single-shot call, returns a full AIMessage
 *   • llm.stream()  — streaming call, yields AIMessageChunk pieces
 *
 * Run:  node examples/01-simple-chat.js
 */

const { buildCopilotLLM } = require('./_setup');

async function main() {
  // ── Import LangChain (ES module via dynamic import) ────────────────────────
  const { ChatOpenAI }                            = await import('@langchain/openai');
  const { SystemMessage, HumanMessage, AIMessage } = await import('@langchain/core/messages');

  // ── Build the LLM ──────────────────────────────────────────────────────────
  // ChatOpenAI speaks the OpenAI chat completions API.
  // Here we point it at GitHub Copilot instead of OpenAI directly.
  const llm = await buildCopilotLLM(ChatOpenAI, { model: 'gpt-4.1' });

  // ── 1. Single-shot invoke ──────────────────────────────────────────────────
  // Pass an array of messages; get back one AIMessage with the full reply.
  console.log('\n── invoke() ──────────────────────────────────────────────────\n');

  const response = await llm.invoke([
    new SystemMessage('You are a concise assistant. Reply in one sentence.'),
    new HumanMessage('What is the capital of France?'),
  ]);

  // response is an AIMessage; .content holds the text
  console.log('AIMessage.content:', response.content);
  console.log('Token usage:', response.usage_metadata);

  // ── 2. Multi-turn conversation ─────────────────────────────────────────────
  // Just keep appending messages — the full history is the "memory".
  console.log('\n── multi-turn ────────────────────────────────────────────────\n');

  const history = [
    new SystemMessage('You are a helpful assistant.'),
    new HumanMessage('My favourite colour is blue.'),
  ];

  const turn1 = await llm.invoke(history);
  console.log('Turn 1:', turn1.content);

  history.push(turn1);                                           // add AI reply
  history.push(new HumanMessage('What is my favourite colour?'));

  const turn2 = await llm.invoke(history);
  console.log('Turn 2:', turn2.content);                        // should say "blue"

  // ── 3. Streaming ───────────────────────────────────────────────────────────
  // llm.stream() returns an async iterator of AIMessageChunk objects.
  // Each chunk has a .content string fragment.
  console.log('\n── stream() ──────────────────────────────────────────────────\n');
  process.stdout.write('Streaming: ');

  const stream = await llm.stream([
    new HumanMessage('Count from 1 to 5, one number per line.'),
  ]);

  for await (const chunk of stream) {
    process.stdout.write(chunk.content); // print each fragment as it arrives
  }
  console.log('\n');
}

main().catch((err) => { console.error(err.message); process.exit(1); });
