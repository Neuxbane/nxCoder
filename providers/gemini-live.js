// Google Gemini Multimodal Live API (Bidirectional WebSocket)

function writeWavHeader(samplesLength, sampleRate = 24000, numChannels = 1, bitsPerSample = 16) {
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);
  
  // "RIFF"
  view.setUint8(0, 0x52); view.setUint8(1, 0x49); view.setUint8(2, 0x46); view.setUint8(3, 0x46);
  view.setUint32(4, 36 + samplesLength, true);
  // "WAVE"
  view.setUint8(8, 0x57); view.setUint8(9, 0x41); view.setUint8(10, 0x56); view.setUint8(11, 0x45);
  // "fmt "
  view.setUint8(12, 0x66); view.setUint8(13, 0x6d); view.setUint8(14, 0x74); view.setUint8(15, 0x20);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, (sampleRate * numChannels * bitsPerSample) / 8, true);
  view.setUint16(32, (numChannels * bitsPerSample) / 8, true);
  view.setUint16(34, bitsPerSample, true);
  // "data"
  view.setUint8(36, 0x64); view.setUint8(37, 0x61); view.setUint8(38, 0x74); view.setUint8(39, 0x61);
  view.setUint32(40, samplesLength, true);
  
  return buffer;
}

function base64ToUint8Array(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function createWavBlob(pcmChunks, sampleRate = 24000) {
  let totalLength = 0;
  for (const chunk of pcmChunks) {
    totalLength += chunk.length;
  }
  const fullPcm = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of pcmChunks) {
    fullPcm.set(chunk, offset);
    offset += chunk.length;
  }
  const header = writeWavHeader(fullPcm.length, sampleRate, 1, 16);
  return new Blob([header, fullPcm], { type: 'audio/wav' });
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function truncateMiddle(str, maxLength = 2500) {
  if (typeof str !== "string" || str.length <= maxLength) return str;
  const half = Math.floor(maxLength / 2);
  const tail = maxLength - half;
  return str.substring(0, half) + `\n... [truncated ${str.length - maxLength} characters] ...\n` + str.substring(str.length - tail);
}

function cleanToolResponse(resp, maxStringLength = 4000) {
  if (typeof resp === "string") return truncateMiddle(resp, maxStringLength);
  if (!resp || typeof resp !== "object") return resp;
  try {
    const clone = JSON.parse(JSON.stringify(resp));
    const clean = (obj) => {
      if (!obj || typeof obj !== "object") return;
      for (const k of Object.keys(obj)) {
        if (k === "inlineImage" || k === "inlineData") {
          obj[k] = "[binary stripped]";
        } else if (k === "data" && typeof obj[k] === "string" && obj[k].length > 200) {
          obj[k] = "[binary data]";
        } else if (typeof obj[k] === "string") {
          obj[k] = truncateMiddle(obj[k], maxStringLength);
        } else if (typeof obj[k] === "object") {
          clean(obj[k]);
        }
      }
    };
    clean(clone);
    return clone;
  } catch (_) {
    return resp;
  }
}

// Module-level persistent WebSocket live session
let activeLiveSession = null;

function closeActiveSession() {
  if (activeLiveSession) {
    console.log("[Gemini Live] Closing active WebSocket session.");
    try {
      const ws = activeLiveSession.ws;
      activeLiveSession.ws = null;
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        try { ws.close(); } catch (_) {}
      }
    } catch (_) {}
    activeLiveSession = null;
  }
}

export default {
  id: "gemini-live",
  name: "Google Gemini Live (WebSockets)",
  description: "Gemini Multimodal Live API for ultra-low latency bidirectional text, audio, and reasoning streams.",
  
  cleanup() {
    closeActiveSession();
  },

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
        "gemini-2.5-flash",
        "gemini-2.0-flash",
        "gemini-2.0-flash-exp",
        "gemini-2.0-flash-realtime-exp",
        "gemini-2.5-flash-native-audio-preview-12-2025",
        "gemini-2.5-flash-native-audio-preview-09-2025"
      ],
      default: "gemini-2.5-flash",
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
    },
    {
      key: "thinking",
      label: "Thinking Level",
      type: "options",
      options: [
        "HIGH",
        "LOW",
        "MINIMAL",
        "OFF"
      ],
      default: "HIGH",
      required: false
    }
  ],

  async *stream({ apiKey, model, voice, thinking, systemInstruction, messages, tools, abortSignal, sessionId }) {
    let targetModel = model || "gemini-2.5-flash";
    if (!targetModel.startsWith("models/")) {
      targetModel = `models/${targetModel}`;
    }

    const selectedVoice = voice || "Zephyr";
    const selectedThinking = (thinking || "HIGH").toUpperCase();

    if (!apiKey) {
      throw new Error("Gemini API key is required for Gemini Live connection.");
    }

    // Extract all system instructions from argument & messages
    let effectiveSystemInstruction = "";
    if (systemInstruction) {
      if (typeof systemInstruction === "string") {
        effectiveSystemInstruction = systemInstruction.trim();
      } else if (systemInstruction.text) {
        effectiveSystemInstruction = systemInstruction.text.trim();
      } else if (Array.isArray(systemInstruction.parts)) {
        effectiveSystemInstruction = systemInstruction.parts.map(p => p.text || "").join("\n").trim();
      } else {
        effectiveSystemInstruction = JSON.stringify(systemInstruction);
      }
    }

    if (Array.isArray(messages)) {
      for (const m of messages) {
        if (m.role === "system") {
          const sysText = typeof m.content === "string" ? m.content : (Array.isArray(m.parts) ? m.parts.map(p => p.text || "").join("\n") : "");
          if (sysText.trim()) {
            effectiveSystemInstruction = effectiveSystemInstruction ? `${effectiveSystemInstruction}\n\n${sysText.trim()}` : sysText.trim();
          }
        }
      }
    }

    // Append anti-echo directive to system instruction
    const antiEchoDirective = "\n\nImportant: You have access to real tools. When you receive [Tool Output], examine the data and proceed with your reasoning or next action. Do not echo internal '[Tool Executed]' or '[Tool Output]' tags in your final conversational response.";
    effectiveSystemInstruction = effectiveSystemInstruction ? (effectiveSystemInstruction + antiEchoDirective) : antiEchoDirective.trim();

    // Check if the current message contains tool responses
    const lastMessage = (messages || []).slice(-1)[0];
    const functionResponses = [];
    const inlineImages = [];

    if (lastMessage && Array.isArray(lastMessage.parts)) {
      for (const part of lastMessage.parts) {
        if (part.functionResponse) {
          const fr = part.functionResponse;
          const rawResp = fr.response?.result !== undefined ? fr.response.result : fr.response;
          functionResponses.push({
            id: fr.id,
            name: fr.name,
            response: {
              result: cleanToolResponse(rawResp)
            }
          });
        } else if (part.inlineData) {
          inlineImages.push(part.inlineData);
        }
      }
    }
    const isToolResponseTurn = functionResponses.length > 0;

    // Check if we can reuse the existing open WebSocket connection
    const canReuseSession =
      activeLiveSession &&
      activeLiveSession.ws &&
      activeLiveSession.ws.readyState === WebSocket.OPEN &&
      activeLiveSession.apiKey === apiKey &&
      activeLiveSession.model === targetModel &&
      activeLiveSession.voice === selectedVoice &&
      activeLiveSession.thinking === selectedThinking &&
      (!sessionId || !activeLiveSession.sessionId || activeLiveSession.sessionId === sessionId);

    if (!canReuseSession) {
      closeActiveSession();

      const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${apiKey}`;
      console.log(`[Gemini Live] Connecting to WebSocket: wss://generativelanguage.googleapis.com/... (Key length: ${apiKey.length})`);
      console.log(`[Gemini Live] Target model: ${targetModel}`);
      if (effectiveSystemInstruction) {
        console.log(`[Gemini Live] System instruction attached (${effectiveSystemInstruction.length} chars)`);
      }

      const ws = new WebSocket(wsUrl);

      let setupResolve, setupReject;
      const setupPromise = new Promise((resolve, reject) => {
        setupResolve = resolve;
        setupReject = reject;
      });

      const sessionState = {
        ws,
        apiKey,
        model: targetModel,
        voice: selectedVoice,
        thinking: selectedThinking,
        systemInstruction: effectiveSystemInstruction,
        sessionId: sessionId || null,
        setupPromise,
        setupResolve,
        setupReject,
        currentConsumer: null,
        audioChunks: [],
        audioMimeType: null,
        pendingToolCalls: new Map()
      };
      activeLiveSession = sessionState;

      ws.onopen = () => {
        console.log("[Gemini Live] Connection opened successfully.");

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
              thinkingConfig: {
                includeThoughts: selectedThinking !== "OFF",
                thinkingBudget: -1
              }
            },
            outputAudioTranscription: {}
          }
        };

        if (effectiveSystemInstruction) {
          setupMsg.setup.systemInstruction = {
            parts: [{ text: effectiveSystemInstruction }]
          };
        }

        if (tools && tools.length > 0) {
          setupMsg.setup.tools = [{
            functionDeclarations: tools.map(t => ({
              name: t.name,
              description: t.description,
              parameters: t.parameters || t.inputSchema || { type: "object", properties: {} }
            }))
          }];
        }

        console.log("[Gemini Live] Outgoing setup frame:", JSON.stringify(setupMsg));
        ws.send(JSON.stringify(setupMsg));
      };

      ws.onmessage = async (event) => {
        try {
          let raw = "";
          if (typeof event.data === "string") raw = event.data;
          else if (event.data instanceof Blob) raw = await event.data.text();
          else if (event.data instanceof ArrayBuffer) raw = new TextDecoder().decode(event.data);
          else if (event.data) raw = event.data.toString();
          if (!raw) return;

          const parsed = JSON.parse(raw);
          console.log("[Gemini Live] Incoming frame payload:", parsed);

          if (parsed.setupComplete !== undefined) {
            console.log("[Gemini Live] Setup complete confirmed by server.");
            sessionState.setupResolve();
            return;
          }

          if (parsed.error) {
            console.error("[Gemini Live] Server error received:", parsed.error);
            const socketErr = new Error(`Gemini Live Error (${parsed.error.code || 'API'}): ${parsed.error.message || JSON.stringify(parsed.error)}`);
            sessionState.currentConsumer?.setError(socketErr);
            closeActiveSession();
            return;
          }

          const consumer = sessionState.currentConsumer;
          let hasFunctionCall = false;

          // Handle thinking, function calls, text, and pcm audio in modelTurn
          if (parsed.serverContent?.modelTurn?.parts) {
            for (const part of parsed.serverContent.modelTurn.parts) {
              if (part.thought) {
                const thoughtText = typeof part.thought === "string" ? part.thought : part.text;
                if (thoughtText && consumer) {
                  console.log("[Gemini Live] Thought chunk:", thoughtText.substring(0, 40) + "...");
                  consumer.pushChunk({ type: "thought", text: thoughtText });
                }
              } else if (part.functionCall) {
                hasFunctionCall = true;
                const callId = part.functionCall.id || ("call_" + Math.random().toString(36).substring(2, 8));
                sessionState.pendingToolCalls.set(callId, { name: part.functionCall.name, args: part.functionCall.args });
                console.log("[Gemini Live] Function call received:", part.functionCall.name, "id:", callId);
                if (consumer) {
                  consumer.pushChunk({
                    type: "functionCall",
                    name: part.functionCall.name,
                    args: part.functionCall.args,
                    callId
                  });
                }
              } else if (part.text) {
                if (consumer) {
                  console.log("[Gemini Live] Text chunk:", part.text.substring(0, 40) + "...");
                  consumer.pushChunk({ type: "text", text: part.text });
                }
              } else if (part.inlineData?.data) {
                if (part.inlineData.mimeType && part.inlineData.mimeType.startsWith("audio/pcm")) {
                  sessionState.audioChunks.push(base64ToUint8Array(part.inlineData.data));
                  sessionState.audioMimeType = part.inlineData.mimeType;
                }
              }
            }
          }

          // Top-level toolCall payload from Gemini Live API
          if (parsed.toolCall?.functionCalls) {
            hasFunctionCall = true;
            for (const fc of parsed.toolCall.functionCalls) {
              const callId = fc.id || ("call_" + Math.random().toString(36).substring(2, 8));
              sessionState.pendingToolCalls.set(callId, { name: fc.name, args: fc.args });
              console.log("[Gemini Live] Tool call received:", fc.name, "id:", callId);
              if (consumer) {
                consumer.pushChunk({
                  type: "functionCall",
                  name: fc.name,
                  args: fc.args,
                  callId
                });
              }
            }
          }

          // Handle speech transcription (text of model voice)
          if (parsed.serverContent?.outputTranscription?.text) {
            const transText = parsed.serverContent.outputTranscription.text;
            if (consumer) {
              console.log("[Gemini Live] Output transcription chunk:", transText.substring(0, 40) + "...");
              consumer.pushChunk({ type: "text", text: transText });
            }
          }

          // If a function call was detected, flush any spoken audio and complete the current turn.
          // The WebSocket remains OPEN so tool responses can be sent back on it.
          if (hasFunctionCall) {
            console.log("[Gemini Live] Tool call detected, completing current turn (keeping WebSocket connection open).");
            if (sessionState.audioChunks.length > 0 && consumer) {
              try {
                let sampleRate = 24000;
                if (sessionState.audioMimeType) {
                  const match = sessionState.audioMimeType.match(/rate=(\d+)/);
                  if (match) sampleRate = parseInt(match[1], 10);
                }
                const wavBlob = createWavBlob(sessionState.audioChunks, sampleRate);
                const wavDataUrl = await blobToDataURL(wavBlob);
                consumer.pushChunk({ type: "media", localPath: wavDataUrl, mimeType: "audio/wav" });
              } catch (mediaErr) {
                console.error("[Gemini Live] Failed to build audio WAV blob:", mediaErr);
              }
              sessionState.audioChunks = [];
            }
            consumer?.finish();
            return;
          }

          // If turnComplete is received, flush final audio and complete turn.
          if (parsed.serverContent?.turnComplete) {
            console.log("[Gemini Live] Server turnComplete flag received.");
            if (sessionState.audioChunks.length > 0 && consumer) {
              try {
                let sampleRate = 24000;
                if (sessionState.audioMimeType) {
                  const match = sessionState.audioMimeType.match(/rate=(\d+)/);
                  if (match) sampleRate = parseInt(match[1], 10);
                }
                const wavBlob = createWavBlob(sessionState.audioChunks, sampleRate);
                const wavDataUrl = await blobToDataURL(wavBlob);
                consumer.pushChunk({ type: "media", localPath: wavDataUrl, mimeType: "audio/wav" });
              } catch (mediaErr) {
                console.error("[Gemini Live] Failed to build audio WAV blob:", mediaErr);
              }
              sessionState.audioChunks = [];
            }
            consumer?.finish();
          }
        } catch (err) {
          console.error("[Gemini Live] Error handling incoming socket frame:", err);
        }
      };

      ws.onerror = (err) => {
        console.error("[Gemini Live] WebSocket client error:", err);
        const socketErr = new Error("Gemini Live WebSocket connection failed. Please check your Gemini API key and network.");
        sessionState.setupReject?.(socketErr);
        sessionState.currentConsumer?.setError(socketErr);
        closeActiveSession();
      };

      ws.onclose = (event) => {
        console.log(`[Gemini Live] WebSocket closed (Code: ${event.code}, Reason: ${event.reason || 'none'}).`);
        if (activeLiveSession === sessionState) {
          activeLiveSession = null;
        }
        if (sessionState.currentConsumer) {
          if (event.code !== 1000) {
            sessionState.currentConsumer.setError(new Error(`Gemini Live connection closed (Code ${event.code}${event.reason ? `: ${event.reason}` : ''}).`));
          } else {
            sessionState.currentConsumer.finish();
          }
        }
      };
    }

    const session = activeLiveSession;

    // Set up this turn's generator consumer
    const messageQueue = [];
    let resolveNext = null;
    let isFinished = false;
    let turnError = null;

    const pushChunk = (chunk) => {
      if (resolveNext) {
        const resolve = resolveNext;
        resolveNext = null;
        resolve({ value: chunk, done: false });
      } else {
        messageQueue.push(chunk);
      }
    };

    const finish = () => {
      if (isFinished) return;
      isFinished = true;
      if (resolveNext) {
        const resolve = resolveNext;
        resolveNext = null;
        resolve({ done: true });
      }
    };

    const setError = (err) => {
      turnError = err;
      finish();
    };

    session.currentConsumer = { pushChunk, finish, setError };

    if (abortSignal) {
      if (abortSignal.aborted) {
        closeActiveSession();
        throw new Error("Stream aborted by user");
      }
      abortSignal.addEventListener("abort", () => {
        console.log("[Gemini Live] Abort signal received, closing socket.");
        closeActiveSession();
        setError(new Error("Generation aborted by user"));
      }, { once: true });
    }

    // Wait for setup frame confirmation if session was just opened
    await session.setupPromise;

    if (isToolResponseTurn) {
      // 1. If any visual assets were returned (e.g. view_image), stream the image frame into the active session
      for (const img of inlineImages) {
        if (img.data) {
          console.log(`[Gemini Live] Sending image frame via realtimeInput.video (${img.mimeType || 'image/png'})`);
          try {
            session.ws.send(JSON.stringify({
              realtimeInput: {
                video: {
                  data: img.data,
                  mimeType: img.mimeType || "image/png"
                }
              }
            }));
          } catch (e) {
            console.warn("[Gemini Live] Failed to send realtime video frame:", e);
          }
        }
      }

      // 2. Send official toolResponse payload matching call IDs over the persistent WebSocket
      const toolResponseMsg = {
        toolResponse: {
          functionResponses
        }
      };
      console.log(`[Gemini Live] Outgoing toolResponse frame (${functionResponses.length} calls):`, JSON.stringify(toolResponseMsg).substring(0, 200) + "...");
      session.ws.send(JSON.stringify(toolResponseMsg));

      for (const fr of functionResponses) {
        session.pendingToolCalls.delete(fr.id);
      }
    } else {
      // User message turn
      if (!canReuseSession) {
        // Initial setup for this session: format conversation history and initial user message
        const historyMessages = (messages || []).filter(m => m.role !== "system").slice(0, -1);
        const currentMessage = (messages || []).filter(m => m.role !== "system").slice(-1)[0];

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
                } else if (part.functionCall) {
                  msgText += `\n[Called Tool: ${part.functionCall.name} with arguments: ${JSON.stringify(part.functionCall.args || {})}]\n`;
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
            if (msgText.trim()) {
              historyString += `${role}: ${msgText.trim()}\n`;
            }
          }
        }

        const liveTurns = [];
        if (currentMessage) {
          const parts = [];
          const textParts = [];
          if (historyString.trim()) {
            textParts.push(historyString.trim() + "\n\n=== CURRENT PROMPT ===\n");
          }

          if (Array.isArray(currentMessage.parts)) {
            for (const part of currentMessage.parts) {
              if (part.text) {
                textParts.push(part.text);
              } else if (part.functionCall) {
                textParts.push(`\n[Called Tool: ${part.functionCall.name} with arguments: ${JSON.stringify(part.functionCall.args || {})}]\n`);
              } else if (part.functionResponse) {
                textParts.push(`\n[Tool Response for ${part.functionResponse.name}: ${JSON.stringify(part.functionResponse.response?.result || part.functionResponse.response)}]\n`);
              } else if (part.inlineData) {
                parts.push({ inlineData: { mimeType: part.inlineData.mimeType, data: part.inlineData.data } });
              }
            }
          } else if (typeof currentMessage.content === "string") {
            textParts.push(currentMessage.content);
          } else if (typeof currentMessage.text === "string") {
            textParts.push(currentMessage.text);
          }

          if (textParts.length > 0) {
            parts.unshift({ text: textParts.join("") });
          }

          if (parts.length > 0) {
            const role = currentMessage.role === "model" || currentMessage.role === "assistant" ? "model" : "user";
            liveTurns.push({ role, parts });
          }
        }

        if (liveTurns.length > 0) {
          const clientContentMsg = {
            clientContent: {
              turns: liveTurns,
              turnComplete: true
            }
          };
          console.log("[Gemini Live] Outgoing initial clientContent frame:", JSON.stringify(clientContentMsg).substring(0, 200) + "...");
          session.ws.send(JSON.stringify(clientContentMsg));
        }
      } else {
        // Continuing open session: send only the new user turn
        const currentMessage = (messages || []).filter(m => m.role !== "system").slice(-1)[0];
        const parts = [];
        if (currentMessage) {
          if (Array.isArray(currentMessage.parts)) {
            for (const part of currentMessage.parts) {
              if (part.text) {
                parts.push({ text: part.text });
              } else if (part.inlineData) {
                parts.push({ inlineData: { mimeType: part.inlineData.mimeType, data: part.inlineData.data } });
              }
            }
          } else if (typeof currentMessage.content === "string") {
            parts.push({ text: currentMessage.content });
          } else if (typeof currentMessage.text === "string") {
            parts.push({ text: currentMessage.text });
          }
        }

        if (parts.length > 0) {
          const clientContentMsg = {
            clientContent: {
              turns: [{ role: "user", parts }],
              turnComplete: true
            }
          };
          console.log("[Gemini Live] Outgoing follow-up user turn frame:", JSON.stringify(clientContentMsg).substring(0, 200) + "...");
          session.ws.send(JSON.stringify(clientContentMsg));
        }
      }
    }

    try {
      while (true) {
        if (turnError) throw turnError;
        if (messageQueue.length > 0) {
          yield messageQueue.shift();
        } else if (isFinished) {
          if (turnError) throw turnError;
          break;
        } else {
          const next = await new Promise(r => { resolveNext = r; });
          if (turnError) throw turnError;
          if (next.done) break;
          yield next.value;
        }
      }
    } finally {
      if (session && session.currentConsumer?.finish === finish) {
        session.currentConsumer = null;
      }
    }
  }
};
