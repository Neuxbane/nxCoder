import { BaseProvider } from './base.js';

export class OpenAIProvider extends BaseProvider {
  static get id() {
    return 'openai';
  }

  static get name() {
    return 'OpenAI Compatible (llama.cpp / Local)';
  }

  static get configSchema() {
    return {
      title: 'OpenAI / llama.cpp Server Configuration',
      fields: [
        {
          id: 'host',
          label: 'Server Host Endpoint URL',
          type: 'text',
          placeholder: 'http://localhost:8080/v1',
          default: 'http://localhost:8080/v1',
          required: true
        },
        {
          id: 'apiKey',
          label: 'API Key (Optional)',
          type: 'password',
          placeholder: 'sk-no-key-required',
          default: 'sk-no-key-required',
          required: false
        },
        {
          id: 'model',
          label: 'Model / Tag Identifier',
          type: 'text',
          placeholder: 'gpt-4o',
          default: 'gpt-4o',
          required: true
        }
      ]
    };
  }

  async executeStream(params, callbacks) {
    const { messages, systemInstruction, tools, signal } = params;
    const host = (this.config.host || 'http://localhost:8080/v1').replace(/\/$/, '');
    const apiKey = this.config.apiKey || 'sk-no-key-required';
    const model = this.config.model || 'gpt-4o';

    // Format tools for OpenAI API
    const formattedTools = (tools || []).map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema || t.parameters
      }
    }));

    // Format messages for OpenAI API
    const openaiMessages = [];
    if (systemInstruction) {
      openaiMessages.push({ role: 'system', content: systemInstruction });
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
          openaiMessages.push({
            role: 'tool',
            tool_call_id: tr.functionResponse.name, // In OpenAI compat, tool response uses tool_call_id
            content: JSON.stringify(tr.functionResponse.response?.result || tr.functionResponse.response)
          });
        }
      } else {
        const openaiMsg = { role, content };
        if (toolCalls.length > 0) {
          openaiMsg.tool_calls = toolCalls;
        }
        openaiMessages.push(openaiMsg);
      }
    }

    const requestBody = {
      model,
      messages: openaiMessages,
      stream: true
    };

    if (formattedTools.length > 0) {
      requestBody.tools = formattedTools;
    }

    const response = await fetch(`${host}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody),
      signal
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`OpenAI request failed (${response.status}): ${errText || response.statusText}`);
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
          const cleanLine = line.trim();
          if (!cleanLine) continue;
          if (cleanLine === 'data: [DONE]') continue;
          if (!cleanLine.startsWith('data: ')) continue;

          const dataStr = cleanLine.slice(6);
          let parsed;
          try {
            parsed = JSON.parse(dataStr);
          } catch (e) {
            console.error('Failed to parse OpenAI stream chunk:', dataStr);
            continue;
          }

          if (parsed.choices && parsed.choices[0]) {
            const delta = parsed.choices[0].delta;
            if (!delta) continue;

            // Handle content text streaming
            if (delta.content) {
              callbacks.onTextChunk?.(delta.content);
            }

            // Handle tool calls
            if (delta.tool_calls && delta.tool_calls.length > 0) {
              for (const tc of delta.tool_calls) {
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
