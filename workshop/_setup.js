/**
 * _setup.js — shared helper for all examples
 *
 * Exports buildCopilotLLM() which returns a ChatOpenAI instance
 * already pointed at the GitHub Copilot API with auth injected.
 *
 * Every example imports this so they can stay focused on the concept
 * they're demonstrating rather than repeating boilerplate.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { getToken } = require('../src/tokenManager');

const COPILOT_BASE_URL = 'https://api.githubcopilot.com';

const COPILOT_HEADERS = {
  'Editor-Version':         'vscode/1.85.0',
  'Editor-Plugin-Version':  'copilot-chat/0.12.0',
  'Copilot-Integration-Id': 'vscode-chat',
  'User-Agent':             'GitHubCopilot/1.1.0',
  'OpenAI-Intent':          'conversation-panel',
};

/**
 * Build a ChatOpenAI instance connected to the Copilot API.
 *
 * @param {import('@langchain/openai').ChatOpenAI} ChatOpenAI  — pass the imported class
 * @param {object} [opts]
 * @param {string} [opts.model='gpt-4.1']
 * @param {number} [opts.temperature=0]
 */
async function buildCopilotLLM(ChatOpenAI, { model = 'gpt-4.1', temperature = 0 } = {}) {
  const token = await getToken();
  return new ChatOpenAI({
    model,
    temperature,
    apiKey: token,
    configuration: {
      baseURL:        COPILOT_BASE_URL,
      defaultHeaders: COPILOT_HEADERS,
    },
  });
}

module.exports = { buildCopilotLLM };
