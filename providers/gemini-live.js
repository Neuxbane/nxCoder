// Google Gemini Multimodal Live API (Bidirectional WebSocket)
export default {
  id: "gemini-live",
  name: "Google Gemini Live (WebSockets)",
  description: "Gemini Multimodal Live API for ultra-low latency bidirectional text, audio, and reasoning streams.",
  
  requirements: [
    {
      key: "apiKey",
      label: "Gemini API Key",
      type: "password",
      placeholder: "AIzaSy...",
      default: "",
      required: true
    },
    {
      key: "model",
      label: "Live Model Name",
      type: "options",
      options: [
        "gemini-3.1-flash-live-preview",
        "gemini-2.5-flash-native-audio-preview-09-2025",
        "gemini-2.5-flash-native-audio-preview-12-2025",
        "gemini-2.5-flash",
        "gemini-2.0-flash",
        "gemini-2.0-flash-exp",
        "gemini-2.0-flash-realtime-exp"
      ],
      default: "gemini-3.1-flash-live-preview",
      required: true
    },
    {
      key: "voice",
      label: "Voice Name",
      type: "options",
      options: [
        "Zephyr",
        "Puck",
        "Aoede",
        "Charon",
        "Kore",
        "Fenrir"
      ],
      default: "Zephyr",
      required: false
    }
  ],

  async *stream({ apiKey, model, voice, messages, tools, abortSignal }) {
    let targetModel = model || "gemini-3.1-flash-live-preview";
    if (!targetModel.startsWith("models/")) {
      targetModel = `models/${targetModel}`;
    }

    const selectedVoice = voice || "Zephyr";

    if (!apiKey) {
      throw new Error("Gemini API key is required for Gemini Live connection.");
    }

    const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${apiKey}`;

    console.log(`[Gemini Live] Connecting to WebSocket: wss://generativelanguage.googleapis.com/... (Key length: ${apiKey.length})`);
    console.log(`[Gemini Live] Target model: ${targetModel}`);

    const ws = new WebSocket(wsUrl);

    const messageQueue = [];
    let resolveNext = null;
    let isFinished = false;
    let socketError = null;
    let setupCompleted = false;
    let receivedAnyData = false;

    const pushChunk = (chunk) => {
      receivedAnyData = true;
      if (resolveNext) {
        const resolve = resolveNext;
        resolveNext = null;
        resolve({ value: chunk, done: false });
      } else {
        messageQueue.push(chunk);
      }
    };

    const finish = () => {
      isFinished = true;
      if (resolveNext) {
        const resolve = resolveNext;
        resolveNext = null;
        resolve({ done: true });
      }
    };

    // 1. Separate history from the current turn
    const historyMessages = (messages || []).slice(0, -1);
    const currentMessage = (messages || [])[messages.length - 1];

    // 2. Format history into a compact string (parity with marketplace gemini-live.js)
    let historyString = "";
    if (historyMessages.length > 0) {
      historyString += "\n\n=========================================\n=== CONVERSATION HISTORY ===\n=========================================\n";
      for (const msg of historyMessages) {
        const role = msg.role === "model" || msg.role === "assistant" ? "Assistant" : "User";
        let msgText = "";
        if (Array.isArray(msg.parts)) {
          for (const part of msg.parts) {
            if (part.text) {
              msgText += part.text;
            } else if (part.thought) {
              // skip internal thinking from history
            } else if (part.functionCall) {
              msgText += `\n[Called Tool: ${part.functionCall.name} with arguments: ${JSON.stringify(part.functionCall.args)}]\n`;
            } else if (part.functionResponse) {
              msgText += `\n[Tool Response for ${part.functionResponse.name}: ${JSON.stringify(part.functionResponse.response?.result || part.functionResponse.response)}]\n`;
            } else if (part.inlineData) {
              msgText += `\n[Inline ${part.inlineData.mimeType || 'media'} data provided]\n`;
            }
          }
        } else if (typeof msg.content === "string") {
          msgText = msg.content;
        } else if (typeof msg.text === "string") {
          msgText = msg.text;
        }
        historyString += `${role}: ${msgText}\n`;
      }
    }

    // 3. Pre-build liveTurns using ONLY the currentMessage
    const liveTurns = [];
    if (currentMessage) {
      const parts = [];
      const textParts = [];
      if (historyString) {
        textParts.push(historyString + "\n\n=== CURRENT PROMPT ===\n");
      }

      if (Array.isArray(currentMessage.parts)) {
        for (const part of currentMessage.parts) {
          if (part.text) {
            textParts.push(part.text);
          } else if (part.inlineData) {
            parts.push({ inlineData: { mimeType: part.inlineData.mimeType, data: part.inlineData.data } });
          }
        }
      } else if (typeof currentMessage.content === "string") {
        textParts.push(currentMessage.content);
      } else if (Array.isArray(currentMessage.content)) {
        for (const p of currentMessage.content) {
          if (p.text) textParts.push(p.text);
        }
      }

      if (textParts.length > 0) {
        parts.unshift({ text: textParts.join("") });
      }

      if (parts.length > 0) {
        const role = currentMessage.role === "model" || currentMessage.role === "assistant" ? "model" : "user";
        liveTurns.push({ role, parts });
      }
    }

    ws.onopen = () => {
      console.log("[Gemini Live] Connection opened successfully.");

      // For Gemini 3+ models, thinkingLevel ('MINIMAL'/'LOW') is used.
      // For Gemini 2.5 models, thinkingBudget (-1) is used.
      const isGemini3 = targetModel.toLowerCase().includes("gemini-3");
      const thinkingConfig = isGemini3
        ? { thinkingLevel: "MINIMAL" }
        : { includeThoughts: true, thinkingBudget: -1 };

      const setupMsg = {
        setup: {
          model: targetModel,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: selectedVoice
                }
              }
            },
            thinkingConfig
          }
        }
      };

      if (tools && tools.length > 0) {
        setupMsg.setup.tools = [{
          functionDeclarations: tools.map(t => ({
            name: t.name,
            description: t.description,
            parameters: t.inputSchema || t.parameters
          }))
        }];
      }

      console.log("[Gemini Live] Outgoing setup frame:", JSON.stringify(setupMsg));
      ws.send(JSON.stringify(setupMsg));
    };

    ws.onmessage = async (event) => {
      try {
        let raw = "";
        if (typeof event.data === "string") {
          raw = event.data;
        } else if (event.data instanceof Blob) {
          raw = await event.data.text();
        } else if (event.data instanceof ArrayBuffer) {
          raw = new TextDecoder().decode(event.data);
        } else if (event.data) {
          raw = event.data.toString();
        }
        if (!raw) return;

        const parsed = JSON.parse(raw);
        console.log("[Gemini Live] Incoming frame payload:", parsed);

        // Server confirmed setup complete -> send clientContent turns
        if (parsed.setupComplete !== undefined) {
          setupCompleted = true;
          console.log("[Gemini Live] Setup complete confirmed by server.");
          if (liveTurns.length > 0) {
            const clientContentMsg = {
              clientContent: {
                turns: liveTurns,
                turnComplete: true
              }
            };
            console.log("[Gemini Live] Outgoing clientContent turns frame:", JSON.stringify(clientContentMsg));
            ws.send(JSON.stringify(clientContentMsg));
          }
          return;
        }

        if (parsed.error) {
          console.error("[Gemini Live] Server error received:", parsed.error);
          socketError = new Error(`Gemini Live Error (${parsed.error.code || 'API'}): ${parsed.error.message || JSON.stringify(parsed.error)}`);
          try { ws.close(); } catch (_) {}
          finish();
          return;
        }

        // Handle thinking, function calls, and content parts
        if (parsed.serverContent?.modelTurn?.parts) {
          for (const part of parsed.serverContent.modelTurn.parts) {
            if (part.thought) {
              const thoughtText = typeof part.thought === "string" ? part.thought : part.text;
              if (thoughtText) {
                console.log("[Gemini Live] Thought chunk:", thoughtText.substring(0, 40) + "...");
                pushChunk({ type: "thought", text: thoughtText });
              }
            } else if (part.functionCall) {
              console.log("[Gemini Live] Function call received:", part.functionCall.name);
              pushChunk({
                type: "functionCall",
                name: part.functionCall.name,
                args: part.functionCall.args,
                callId: part.functionCall.id || ("call_" + Math.random().toString(36).substring(2, 8))
              });
            } else if (part.text) {
              console.log("[Gemini Live] Text chunk:", part.text.substring(0, 40) + "...");
              pushChunk({ type: "text", text: part.text });
            }
          }
        }

        if (parsed.toolCall?.functionCalls) {
          for (const fc of parsed.toolCall.functionCalls) {
            console.log("[Gemini Live] Tool call received:", fc.name);
            pushChunk({
              type: "functionCall",
              name: fc.name,
              args: fc.args,
              callId: fc.id || ("call_" + Math.random().toString(36).substring(2, 8))
            });
          }
        }

        // Handle output transcriptions (AUDIO modality text output)
        if (parsed.serverContent?.outputTranscription?.text) {
          const transText = parsed.serverContent.outputTranscription.text;
          console.log("[Gemini Live] Output transcription chunk:", transText.substring(0, 40) + "...");
          pushChunk({ type: "text", text: transText });
        }

        if (parsed.serverContent?.turnComplete) {
          console.log("[Gemini Live] Server turnComplete flag received.");
          try { ws.close(); } catch (_) {}
          finish();
        }
      } catch (err) {
        console.error("[Gemini Live] Error parsing incoming socket frame:", err);
      }
    };

    ws.onerror = (err) => {
      console.error("[Gemini Live] WebSocket client error:", err);
      if (!isFinished && !receivedAnyData) {
        socketError = new Error("Gemini Live WebSocket connection failed. Please check your Gemini API key and network.");
      }
      finish();
    };

    ws.onclose = (event) => {
      console.log(`[Gemini Live] WebSocket closed (Code: ${event.code}, Reason: ${event.reason || 'none'}).`);
      if (!isFinished) {
        const reasonStr = event.reason ? `: ${event.reason}` : "";
        if (event.code !== 1000) {
          socketError = new Error(`Gemini Live connection closed (Code ${event.code}${reasonStr}). Please verify your API key and model.`);
        }
      }
      finish();
    };

    if (abortSignal) {
      abortSignal.addEventListener("abort", () => {
        console.log("[Gemini Live] Abort signal received, closing socket.");
        try { ws.close(); } catch (_) {}
        finish();
      });
    }

    while (true) {
      if (socketError) throw socketError;
      if (messageQueue.length > 0) {
        yield messageQueue.shift();
      } else if (isFinished) {
        if (socketError) throw socketError;
        break;
      } else {
        const next = await new Promise(r => { resolveNext = r; });
        if (socketError) throw socketError;
        if (next.done) break;
        yield next.value;
      }
    }
  }
};
