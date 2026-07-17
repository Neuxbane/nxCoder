import { GoogleGenAI } from '@google/genai';
import { BaseProvider } from './base.js';

function mapSchemaTypesToUppercase(schema) {
  if (!schema) return schema;
  const newSchema = { ...schema };
  if (typeof newSchema.type === 'string') {
    newSchema.type = newSchema.type.toUpperCase();
  }
  if (newSchema.properties) {
    newSchema.properties = { ...newSchema.properties };
    for (const key in newSchema.properties) {
      newSchema.properties[key] = mapSchemaTypesToUppercase(newSchema.properties[key]);
    }
  }
  if (newSchema.items) {
    newSchema.items = mapSchemaTypesToUppercase(newSchema.items);
  }
  return newSchema;
}

export class GeminiProvider extends BaseProvider {
  static get id() {
    return 'gemini';
  }

  static get name() {
    return 'Google Gemini';
  }

  static get configSchema() {
    return {
      title: 'Google Gemini Configuration',
      fields: [
        {
          id: 'apiKey',
          label: 'API Key',
          type: 'password',
          placeholder: 'AIzaSy...',
          required: true
        },
        {
          id: 'defaultModel',
          label: 'Default Model',
          type: 'select',
          options: ['gemini-2.5-flash', 'gemini-2.5-pro'],
          default: 'gemini-2.5-flash',
          required: true
        }
      ]
    };
  }

  async executeStream(params, callbacks) {
    const { messages, systemInstruction, tools, signal } = params;
    const apiKey = this.config.apiKey;
    const model = this.config.defaultModel || 'gemini-2.5-flash';

    if (!apiKey) {
      throw new Error('API key is missing in Gemini configuration.');
    }

    const ai = new GoogleGenAI({ apiKey });

    // Format tools for Gemini API structure
    const formattedTools = (tools || []).map(t => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: mapSchemaTypesToUppercase(t.inputSchema || t.parameters)
    }));

    // Convert messages to history steps structure
    const historySteps = messages.map(msg => {
      // Map parts to SDK structure
      const parts = msg.parts.map(part => {
        if (part.text) {
          return { text: part.text };
        }
        if (part.thought) {
          return { text: part.text }; // Gemini SDK text parts
        }
        if (part.functionCall) {
          return {
            functionCall: {
              name: part.functionCall.name,
              args: part.functionCall.args
            }
          };
        }
        if (part.functionResponse) {
          return {
            functionResponse: {
              name: part.functionResponse.name,
              response: part.functionResponse.response
            }
          };
        }
        return part;
      });

      return {
        role: msg.role === 'model' ? 'model' : 'user',
        parts
      };
    });

    const createParams = {
      model,
      store: false,
      input: historySteps,
      stream: true,
      system_instruction: systemInstruction
    };

    if (formattedTools.length > 0) {
      createParams.tools = formattedTools;
    }

    const stream = await ai.interactions.create(createParams);

    for await (const event of stream) {
      if (signal && signal.aborted) {
        break;
      }

      if (event.event_type === 'step.start') {
        if (event.step && event.step.type === 'function_call') {
          callbacks.onStepStart?.({
            id: event.step.id,
            name: event.step.name
          });
        }
      } else if (event.event_type === 'step.delta') {
        if (event.delta) {
          if (event.delta.type === 'text' && event.delta.text) {
            callbacks.onTextChunk?.(event.delta.text);
          } else if (event.delta.type === 'thought_summary' && event.delta.content && event.delta.content.text) {
            callbacks.onThoughtChunk?.(event.delta.content.text);
          } else if (event.delta.type === 'arguments_delta' && event.delta.arguments) {
            callbacks.onStepDelta?.(event.delta.arguments);
          }
        }
      } else if (event.event_type === 'step.stop') {
        callbacks.onStepStop?.();
      }
    }
  }
}
