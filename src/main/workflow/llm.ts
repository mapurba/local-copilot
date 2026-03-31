import { streamChatCompletion, ChatMessage } from '../copilotChatApi';
import { DEFAULT_SYSTEM_PROMPT } from './prompts';

export async function generateJson(modelId: string, userPrompt: string, systemPrompt = DEFAULT_SYSTEM_PROMPT): Promise<any> {
  return new Promise((resolve, reject) => {
    let out = '';
    try {
      const messages: ChatMessage[] = [{ role: 'user', content: userPrompt }];
      streamChatCompletion(
        modelId,
        messages,
        (chunk: string) => {
          out += chunk;
        },
        () => {
          try {
            const parsed = JSON.parse(out);
            resolve(parsed);
          } catch (e) {
            // try to strip code fences if present
            const cleaned = out.replace(/```(?:json)?\n?/g, '').replace(/```/g, '').trim();
            try {
              resolve(JSON.parse(cleaned));
            } catch (e2) {
              // fallback: return raw text
              resolve(cleaned);
            }
          }
        },
        (err: Error) => reject(err),
        undefined,
        systemPrompt
      );
    } catch (err) {
      reject(err);
    }
  });
}
