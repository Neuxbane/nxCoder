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
          placeholder: 'models/gemini-3.1-flash-live-preview',
          default: 'models/gemini-3.1-flash-live-preview',
          required: true
        }
      ]
    };
  }

  async executeStream(params, callbacks) {
    const { messages, systemInstruction, tools, signal } = params;
    const apiKey = this.config.apiKey || process.env.GEMINI_API_KEY;
    let model = this.config.model || 'models/gemini-3.1-flash-live-preview';

    if (!apiKey) {
      throw new Error('API key is required for Gemini Live connection.');
    }

    if (!model.startsWith('models/')) {
      model = `models/${model}`;
    }

    const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${apiKey}`;

    console.log(`[Gemini Live] Connecting to: wss://generativelanguage.googleapis.com/... (Key length: ${apiKey.length})`);
    console.log(`[Gemini Live] Targeted model formatted parameter: ${model}`);

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);

      if (signal) {
        signal.addEventListener('abort', () => {
          console.log('[Gemini Live] Abort signal received, closing socket.');
          ws.close();
          reject(new Error('Operation aborted'));
        });
      }

      // Pre-build liveTurns so they are ready when setupComplete arrives
      const liveTurns = [];
      for (const msg of messages) {
        const role = msg.role === 'model' ? 'model' : 'user';
        const partsStr = [];

        for (const part of msg.parts) {
          if (part.text) {
            partsStr.push(part.text);
          } else if (part.functionCall) {
            partsStr.push(`[Called Tool: ${part.functionCall.name} with arguments: ${JSON.stringify(part.functionCall.args)}]`);
          } else if (part.functionResponse) {
            partsStr.push(`[Tool Response for ${part.functionResponse.name}: ${JSON.stringify(part.functionResponse.response?.result || part.functionResponse.response)}]`);
          }
        }

        if (partsStr.length > 0) {
          const combinedText = partsStr.join('');
          if (liveTurns.length > 0 && liveTurns[liveTurns.length - 1].role === role) {
            liveTurns[liveTurns.length - 1].parts[0].text += '\n' + combinedText;
          } else {
            liveTurns.push({ role, parts: [{ text: combinedText }] });
          }
        }
      }

      ws.on('open', () => {
        console.log('[Gemini Live] Connection opened successfully.');

        // Send Setup frame only — clientContent MUST wait for setupComplete from server
        const setupMsg = {
          setup: {
            model,
            generationConfig: {
              responseModalities: ["AUDIO"]
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

        console.log('[Gemini Live] Outgoing setup frame:', JSON.stringify(setupMsg));
        ws.send(JSON.stringify(setupMsg));
      });

      ws.on('message', (data) => {
        try {
          const parsed = JSON.parse(data.toString());
          console.log('[Gemini Live] Incoming frame payload:', JSON.stringify(parsed));

          // Send history turns only AFTER server confirms setup is complete
          if (parsed.setupComplete !== undefined) {
            if (liveTurns.length > 0) {
              const clientContentMsg = {
                clientContent: {
                  turns: liveTurns,
                  turnComplete: true
                }
              };
              console.log('[Gemini Live] Outgoing clientContent turns frame:', JSON.stringify(clientContentMsg));
              ws.send(JSON.stringify(clientContentMsg));
            }
            return;
          }

          // Handle server content text parts (if any)
          if (parsed.serverContent?.modelTurn?.parts) {
            for (const part of parsed.serverContent.modelTurn.parts) {
              if (part.text) {
                callbacks.onTextChunk?.(part.text);
              }
            }
          }

          // Handle output transcriptions when response modality is AUDIO
          if (parsed.serverContent?.outputTranscription?.text) {
            callbacks.onTextChunk?.(parsed.serverContent.outputTranscription.text);
          }

          // Handle tool call events (Top-level toolCall payload)
          if (parsed.toolCall?.functionCalls) {
            console.log('[Gemini Live] Server function call request detected:', JSON.stringify(parsed.toolCall.functionCalls));
            (async () => {
              try {
                const functionResponses = [];
                for (const call of parsed.toolCall.functionCalls) {
                  const callId = call.id || `call_${Math.random().toString(36).substring(2, 9)}`;
                  callbacks.onStepStart?.({
                    id: callId,
                    name: call.name
                  });
                  const argsStr = JSON.stringify(call.args || {});
                  callbacks.onStepDelta?.(argsStr);
                  callbacks.onStepStop?.();

                  let toolResult = {};
                  if (callbacks.onToolCall) {
                    toolResult = await callbacks.onToolCall(call.name, call.args, callId);
                  }
                  functionResponses.push({
                    id: callId,
                    name: call.name,
                    response: { result: toolResult }
                  });
                }

                const toolResponseMsg = {
                  toolResponse: {
                    functionResponses
                  }
                };
                console.log('[Gemini Live] Outgoing toolResponse frame:', JSON.stringify(toolResponseMsg));
                ws.send(JSON.stringify(toolResponseMsg));
              } catch (err) {
                console.error('[Gemini Live] Tool execution error:', err);
                ws.close();
                reject(err);
              }
            })();
            return;
          }

          if (parsed.serverContent?.turnComplete) {
            console.log('[Gemini Live] Server turnComplete flag received.');
            ws.close();
            resolve();
          }
        } catch (err) {
          console.error('[Gemini Live] Error parsing incoming socket frame:', err);
          ws.close();
          reject(err);
        }
      });

      ws.on('error', (err) => {
        console.error('[Gemini Live] WebSocket client error connection event:', err);
        reject(err);
      });

      ws.on('close', (code, reason) => {
        console.log(`[Gemini Live] WebSocket closed (Code: ${code}, Reason: ${reason || 'none'}).`);
        resolve();
      });
    });
  }
}
