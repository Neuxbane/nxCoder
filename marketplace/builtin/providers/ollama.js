import { BaseProvider } from './base.js';

export class OllamaProvider extends BaseProvider {
  static get id() {
    return 'ollama';
  }

  static get name() {
    return 'Ollama (Local LLM)';
  }

  static get configSchema() {
    return {
      title: 'Ollama Server Configuration',
      fields: [
        {
          id: 'host',
          label: 'Ollama Host URL',
          type: 'text',
          placeholder: 'http://localhost:11434',
          default: 'http://localhost:11434',
          required: true
        },
        {
          id: 'model',
          label: 'Model Name',
          type: 'text',
          placeholder: 'llama3',
          default: 'llama3',
          required: true
        },
        {
          id: 'meow',
          label: 'Meow Name',
          type: 'text',
          placeholder: 'llama3',
          default: 'llama3',
          required: true
        }
      ]
    };
  }

  async executeStream(params, callbacks) {
    const { messages, systemInstruction, tools, signal } = params;
    const host = (this.config.host || 'http://localhost:11434').replace(/\/$/, '');
    const model = this.config.model || 'llama3';

    // Format tools for Ollama API (OpenAI style)
    const formattedTools = (tools || []).map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema || t.parameters
      }
    }));

    // Format messages for Ollama API
    const ollamaMessages = [];
    if (systemInstruction) {
      ollamaMessages.push({ role: 'system', content: systemInstruction });
    }

    for (const msg of messages) {
      const role = msg.role === 'model' ? 'assistant' : 'user';
      let content = '';
      const toolCalls = [];

      for (const part of msg.parts) {
        if (part.text) {
          content += part.text;
        } else if (part.thought) {
          content += `<thought>${part.text}</thought>`;
        } else if (part.functionCall) {
          toolCalls.push({
            id: part.functionCall.id || `call_${Math.random().toString(36).substring(2, 9)}`,
            type: 'function',
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args)
            }
          });
        }
      }

      // If it is a tool response message
      const toolResponseParts = msg.parts.filter(p => p.functionResponse);
      if (toolResponseParts.length > 0) {
        for (const tr of toolResponseParts) {
          ollamaMessages.push({
            role: 'tool',
            name: tr.functionResponse.name,
            content: JSON.stringify(tr.functionResponse.response?.result || tr.functionResponse.response)
          });
        }
      } else {
        const ollamaMsg = { role, content };
        if (toolCalls.length > 0) {
          ollamaMsg.tool_calls = toolCalls;
        }
        ollamaMessages.push(ollamaMsg);
      }
    }

    const requestBody = {
      model,
      messages: ollamaMessages,
      stream: true
    };

    if (formattedTools.length > 0) {
      requestBody.tools = formattedTools;
    }

    const response = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Ollama request failed (${response.status}): ${errText || response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let isFunctionCalling = false;
    let currentCallId = null;
    let currentCallName = null;
    let currentArguments = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep partial line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;
          let parsed;
          try {
            parsed = JSON.parse(line);
          } catch (e) {
            console.error('Failed to parse Ollama stream line:', line);
            continue;
          }

          if (parsed.message) {
            const msg = parsed.message;

            // Handle content text streaming
            if (msg.content) {
              callbacks.onTextChunk?.(msg.content);
            }

            // Handle tool calls
            if (msg.tool_calls && msg.tool_calls.length > 0) {
              for (const tc of msg.tool_calls) {
                if (tc.function) {
                  if (!isFunctionCalling) {
                    isFunctionCalling = true;
                    currentCallId = tc.id || `call_${Math.random().toString(36).substring(2, 9)}`;
                    currentCallName = tc.function.name;
                    callbacks.onStepStart?.({
                      id: currentCallId,
                      name: currentCallName
                    });
                  }
                  if (tc.function.arguments) {
                    currentArguments += tc.function.arguments;
                    callbacks.onStepDelta?.(tc.function.arguments);
                  }
                }
              }
            }
          }
        }
      }

      if (isFunctionCalling) {
        callbacks.onStepStop?.();
      }
    } finally {
      reader.releaseLock();
    }
  }
}
