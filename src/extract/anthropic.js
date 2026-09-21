/**
 * Server-side vision adapter.
 *
 * The one place in the server build that talks to a model. Everything it
 * returns is passed through `coerceExtraction` before any other code sees
 * it, so a malformed or hostile response cannot reach the rules engine in
 * an unexpected shape.
 */

import Anthropic from '@anthropic-ai/sdk';
import { EXTRACTION_PROMPT, coerceExtraction, emptyExtraction } from './prompt.js';

/**
 * Model choice is a latency decision, not a quality one.
 *
 * Sarah Chen's hard requirement is a result inside about five seconds,
 * because the previous vendor pilot died at 30-40 seconds per label. The
 * small fast model reads a label reliably and returns in roughly a
 * second, so it is the default; MODEL can be overridden per deployment if
 * a harder corpus needs it.
 */
const DEFAULT_MODEL = process.env.TTB_MODEL || 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 2048;

let client = null;
function getClient() {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set.');
    client = new Anthropic({ apiKey });
  }
  return client;
}

/** Pull the first JSON value out of a model reply, tolerantly. */
export function parseJsonReply(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.search(/[{[]/);
    const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Read one label image.
 *
 * @param {Buffer} imageBuffer
 * @param {string} mediaType  e.g. "image/jpeg"
 * @returns {Promise<{extraction: object, timing: object}>}
 */
export async function extractLabel(imageBuffer, mediaType, { signal } = {}) {
  const started = Date.now();
  try {
    const response = await getClient().messages.create(
      {
        model: DEFAULT_MODEL,
        max_tokens: MAX_TOKENS,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: mediaType, data: imageBuffer.toString('base64') },
              },
              { type: 'text', text: EXTRACTION_PROMPT },
            ],
          },
        ],
      },
      { signal },
    );

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    const parsed = parseJsonReply(text);
    if (!parsed) {
      return {
        extraction: emptyExtraction('The label could not be read into a usable result.'),
        timing: { ms: Date.now() - started, model: DEFAULT_MODEL, parsed: false },
      };
    }

    return {
      extraction: coerceExtraction(parsed),
      timing: {
        ms: Date.now() - started,
        model: DEFAULT_MODEL,
        parsed: true,
        inputTokens: response.usage?.input_tokens ?? null,
        outputTokens: response.usage?.output_tokens ?? null,
      },
    };
  } catch (err) {
    return {
      extraction: emptyExtraction(`Label could not be read: ${err.message}`),
      timing: { ms: Date.now() - started, model: DEFAULT_MODEL, parsed: false, error: err.message },
    };
  }
}
