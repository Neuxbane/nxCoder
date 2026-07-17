import { BaseProvider } from './base.js';
import WebSocket from 'ws';

export class GeminiLiveProvider extends BaseProvider {
  static get id() {
    return 'gemini-live';
  }

  static get name() {
    return 'Google Gemini Live (WebSockets)';
  }

  static get configSchema() {
    return {
      title: 'Gemini Live Service Configuration',
      fields: [
        {
          id: 'apiKey',
          label: 'Gemini API Key',
          type: 'password',
          placeholder: 'AIzaSy...',
          default: '',
          required: true
        },
        {
          id: 'model',
          label: 'Live Model Name',
          type: 'text',
          placeholder: 'models/gemini-2.0-flash-exp',
          default: 'models/gemini-2.0-flash-exp',
          required: true
        }
      ]
    };
  }

  async executeStream(params, callbacks) {
    const { messages, systemInstruction, tools, signal } = params;
    const apiKey = this.config.apiKey || process.env.GEMINI_API_KEY;
    const model = this.config.model || 'models/gemini-2.0-flash-exp';

    if (!apiKey) {
      throw new Error('API key is required for Gemini Live connection.');
    }

    const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${apiKey}`;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);

      // Handle external cancel/abort signal
      if (signal) {
        signal.addEventListener('abort', () => {
          ws.close();
          reject(new Error('Operation aborted'));
        });
      }

      ws.on('open', () => {
        // 1. Send Setup message
        const setupMsg = {
          setup: {
            model,
            generationConfig: {
              responseModalities: ["TEXT"]
            }
          }
        };

        if (systemInstruction) {
          setupMsg.setup.systemInstruction = {
            parts: [{ text: systemInstruction }]
          };
        }

        if (tools && tools.length > 0) {
          setupMsg.setup.tools = [{
            functionDeclarations: tools.map(t => ({
              name: t.name,
              description: t.description,
              parameters: t.inputSchema || t.parameters
            }))
          }];
        }

        ws.send(JSON.stringify(setupMsg));

        // 2. Format and send messages context history
        const liveTurns = [];
        for (const msg of messages) {
          const role = msg.role === 'model' ? 'model' : 'user';
          const parts = [];

          for (const part of msg.parts) {
            if (part.text) {
              parts.push({ text: part.text });
            } else if (part.functionCall) {
              parts.push({
                functionCall: {
                  name: part.functionCall.name,
                  args: part.functionCall.args,
                  id: part.functionCall.id
                }
              });
            } else if (part.functionResponse) {
              parts.push({
                functionResponse: {
                  name: part.functionResponse.name,
                  response: part.functionResponse.response
                }
              });
            }
          }

          if (parts.length > 0) {
            liveTurns.push({ role, parts });
          }
        }

        // Send turns
        if (liveTurns.length > 0) {
          const clientContentMsg = {
            clientContent: {
              turns: liveTurns,
              turnComplete: true
            }
          };
          ws.send(JSON.stringify(clientContentMsg));
        }
      });

      let isFunctionCalling = false;
      let currentCallId = null;
      let currentCallName = null;

      ws.on('message', (data) => {
        try {
          const parsed = JSON.parse(data.toString());

          // Handle server content chunks
          if (parsed.serverContent?.modelTurn?.parts) {
            for (const part of parsed.serverContent.modelTurn.parts) {
              if (part.text) {
                callbacks.onTextChunk?.(part.text);
              }

              // Handle function calls
              if (part.functionCalls) {
                for (const call of part.functionCalls) {
                  if (!isFunctionCalling) {
                    isFunctionCalling = true;
                    currentCallId = call.id || `call_${Math.random().toString(36).substring(2, 9)}`;
                    currentCallName = call.name;
                    callbacks.onStepStart?.({
                      id: currentCallId,
                      name: currentCallName
                    });
                  }
                  const argsStr = JSON.stringify(call.args || {});
                  callbacks.onStepDelta?.(argsStr);
                }
              }
            }
          }

          if (parsed.serverContent?.turnComplete) {
            if (isFunctionCalling) {
              callbacks.onStepStop?.();
            }
            ws.close();
            resolve();
          }
        } catch (err) {
          ws.close();
          reject(err);
        }
      });

      ws.on('error', (err) => {
        reject(err);
      });

      ws.on('close', () => {
        if (isFunctionCalling) {
          callbacks.onStepStop?.();
        }
        resolve();
      });
    });
  }
}
