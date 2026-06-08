import {
  messageEvent, toolUseEvent, toolResultEvent,
  reasoningEvent, statusEvent, usageEvent,
  textDeltaEvent,
} from '../normalizer.mjs';

/**
 * Claude Code adapter.
 *
 * When run with `claude -p --output-format stream-json --verbose
 * --include-partial-messages`, stdout emits JSONL with BOTH partial assistant
 * messages AND streaming events (text_delta, thinking_delta).
 *
 * Dedup strategy: buffer text blocks from partial assistant messages and only
 * emit the final accumulated text when a non-text block (tool_use, thinking)
 * or a result event follows. This avoids rendering the same text multiple
 * times while ensuring the permanent message div is always created.
 */
export function createClaudeAdapter() {
  let lastTurnInputTokens = 0;
  // Buffered text from partial assistant messages — flushed when a non-text
  // block (tool_use, thinking) or result event arrives, or in flush().
  let pendingText = null;

  function flushPendingText() {
    if (pendingText === null) return [];
    const text = pendingText;
    pendingText = null;
    return [messageEvent('assistant', text)];
  }

  return {
    parseLine(line) {
      const trimmed = line.trim();
      if (!trimmed) return [];

      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        return [];
      }

      const events = [];

      switch (obj.type) {
        case 'system':
          events.push(...flushPendingText());
          events.push(statusEvent(obj.subtype === 'init'
            ? `Session started (${obj.session_id || 'unknown'})`
            : `System: ${obj.subtype || 'unknown'}`));
          break;

        case 'assistant': {
          const msg = obj.message;
          const msgUsage = msg?.usage;
          if (msgUsage) {
            lastTurnInputTokens =
              (msgUsage.input_tokens || 0) +
              (msgUsage.cache_creation_input_tokens || 0) +
              (msgUsage.cache_read_input_tokens || 0);
          }

          const content = msg?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text') {
                // Buffer text — will be flushed when a non-text block or result follows
                pendingText = block.text || '';
              } else if (block.type === 'thinking') {
                events.push(...flushPendingText());
                events.push(reasoningEvent(block.thinking));
              } else if (block.type === 'tool_use') {
                events.push(...flushPendingText());
                events.push(toolUseEvent(
                  block.name,
                  typeof block.input === 'string'
                    ? block.input
                    : JSON.stringify(block.input, null, 2),
                ));
              } else if (block.type === 'tool_result') {
                events.push(...flushPendingText());
                const output = typeof block.content === 'string'
                  ? block.content
                  : Array.isArray(block.content)
                    ? block.content.map(c => c.text || '').join('\n')
                    : JSON.stringify(block.content);
                events.push(toolResultEvent(block.tool_use_id || '', output));
              }
            }
          }
          break;
        }

        case 'user': {
          const content = obj.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_result') {
                const output = typeof block.content === 'string'
                  ? block.content
                  : Array.isArray(block.content)
                    ? block.content.map(c => c.text || '').join('\n')
                    : JSON.stringify(block.content);
                events.push(toolResultEvent(
                  block.tool_use_id || '',
                  output,
                  block.is_error ? 1 : 0,
                ));
              }
            }
          }
          break;
        }

        case 'result':
          events.push(...flushPendingText());
          if (obj.cost_usd !== undefined || obj.estimated_cost_usd !== undefined || obj.usage) {
            const u = obj.usage || {};
            const totalIn = Number.isFinite(u.context_tokens)
              ? u.context_tokens
              : lastTurnInputTokens || (
              (u.input_tokens || 0) +
              (u.cache_creation_input_tokens || 0) +
              (u.cache_read_input_tokens || 0)
            );
            events.push(usageEvent({
              contextTokens: totalIn,
              inputTokens: u.input_tokens || 0,
              outputTokens: u.output_tokens || 0,
              ...(Number.isFinite(u.cached_input_tokens) ? { cachedInputTokens: u.cached_input_tokens } : {}),
              ...(Number.isFinite(u.reasoning_output_tokens) ? { reasoningTokens: u.reasoning_output_tokens } : {}),
              ...(Number.isFinite(obj.cost_usd) ? { costUsd: obj.cost_usd } : {}),
              ...(Number.isFinite(obj.estimated_cost_usd) ? { estimatedCostUsd: obj.estimated_cost_usd } : {}),
              ...(typeof obj.estimated_cost_model === 'string' && obj.estimated_cost_model
                ? { estimatedCostModel: obj.estimated_cost_model }
                : {}),
              contextSource: 'provider_turn_usage',
              ...(obj.cost_usd !== undefined
                ? { costSource: 'provider_reported' }
                : (typeof obj.cost_source === 'string' && obj.cost_source
                    ? { costSource: obj.cost_source }
                    : {})),
            }));
          }
          events.push(statusEvent('completed'));
          break;

        case 'stream_event': {
          const evt = obj.event;
          if (!evt) break;
          if (evt.type === 'content_block_delta') {
            if (evt.delta?.type === 'thinking_delta') {
              events.push(reasoningEvent(evt.delta.thinking || ''));
            } else if (evt.delta?.type === 'text_delta') {
              const blockIndex = Number.isInteger(evt.index) ? evt.index : 0;
              events.push(textDeltaEvent(blockIndex, evt.delta.text || ''));
            }
          }
          break;
        }

        default:
          break;
      }

      return events;
    },

    flush() {
      return flushPendingText();
    },
  };
}

/**
 * Build the command-line arguments for spawning Claude Code.
 */
export function buildClaudeArgs(prompt, options = {}) {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];

  if (options.maxTurns) {
    args.push('--max-turns', String(options.maxTurns));
  }
  if (options.resume) {
    args.push('--resume', options.resume);
  }
  if (options.continue) {
    args.push('--continue');
  }
  if (options.allowedTools) {
    args.push('--allowedTools', ...options.allowedTools);
  }
  if (options.dangerouslySkipPermissions) {
    args.push('--dangerously-skip-permissions');
  }

  if (options.model) {
    args.push('--model', options.model);
  }
  const effort = typeof options.effort === 'string' ? options.effort.trim() : '';
  if (effort && effort !== 'none') {
    args.push('--effort', effort);
  } else if (!effort && options.thinking) {
    args.push('--effort', 'high');
  }
  // effort === 'none' → no --effort flag → thinking disabled

  return args;
}
