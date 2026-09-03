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

export default {
  id: "gemini-live",
  name: "Google Gemini Live (WebSockets)",
  description: "Gemini Multimodal Live API for ultra-low latency bidirectional text, audio, and reasoning streams.",
  
  cleanup() {
    // Episodic per-turn WebSocket requires no persistent state cleanup
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
        "gemini-3.1-flash-live-preview",
        "gemini-2.5-flash",
        "gemini-2.0-flash",
        "gemini-2.0-flash-exp",
        "gemini-2.0-flash-realtime-exp",
        "gemini-2.5-flash-native-audio-preview-12-2025",
        "gemini-2.5-flash-native-audio-preview-09-2025"
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
    let targetModel = model || "gemini-3.1-flash-live-preview";
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

    // Append voice response directive to system instruction
    const voiceDirective = "\n\nImportant Voice Interaction Guidelines:\n" +
      "1. You are communicating via live voice. Always provide a spoken voice response answering the user or explaining your findings. Never complete a turn silently after thinking.\n" +
      "2. When inspecting images or tool outputs, describe and explain what you observe in the image/data and answer the user's question directly. If image processing, asset editing, or code modifications are required, write and run scripts via `execute_command` (e.g. Python Pillow/OpenCV/ImageMagick) or guide the user on code edits.\n" +
      "3. Do not echo internal '[Tool Executed]' or '[Tool Output]' tags in your spoken response.";
    effectiveSystemInstruction = effectiveSystemInstruction ? (effectiveSystemInstruction + voiceDirective) : voiceDirective.trim();

    // Separate history from current turn (stable logic from branch main)
    const historyMessages = (messages || []).filter(m => m.role !== "system").slice(0, -1);
    const currentMessage = (messages || []).filter(m => m.role !== "system").slice(-1)[0];

    // Format history into a compact string context (no blobs in history)
    let historyString = "";
    if (historyMessages.length > 0) {
      historyString += "\n\n=========================================\n=== CONVERSATION HISTORY ===\n=========================================\n";
      for (const msg of historyMessages) {
        const role = (msg.role === "model" || msg.role === "assistant") ? "Assistant" : "User";
        let msgText = "";
        const parts = Array.isArray(msg.parts) ? msg.parts : (typeof msg.content === "string" ? [{ text: msg.content }] : []);
        for (const part of parts) {
          if (part.text) {
            msgText += part.text;
          } else if (part.thought) {
            // skip internal thinking from history
          } else if (part.functionCall) {
            msgText += `\n[Called Tool: ${part.functionCall.name} with arguments: ${JSON.stringify(part.functionCall.args || {})}]\n`;
          } else if (part.functionResponse) {
            const res = part.functionResponse.response?.result !== undefined ? part.functionResponse.response.result : part.functionResponse.response;
            msgText += `\n[Tool Response for ${part.functionResponse.name}: ${JSON.stringify(cleanToolResponse(res))}]\n`;
          } else if (part.inlineData) {
            msgText += `\n[Inline ${part.inlineData.mimeType || 'media'} data provided]\n`;
          }
        }
        if (msgText.trim()) {
          historyString += `${role}: ${msgText.trim()}\n`;
        }
      }
    }

    // Pre-build liveTurns using ONLY currentMessage, supporting native multimodal inlineData parts
    const liveTurns = [];
    if (currentMessage) {
      const parts = [];
      const textParts = [];
      if (historyString.trim()) {
        textParts.push(historyString.trim() + "\n\n=== CURRENT PROMPT ===\n");
      }

      const currentParts = Array.isArray(currentMessage.parts) ? currentMessage.parts : (typeof currentMessage.content === "string" ? [{ text: currentMessage.content }] : (typeof currentMessage.text === "string" ? [{ text: currentMessage.text }] : []));
      for (const part of currentParts) {
        if (part.text) {
          textParts.push(part.text);
        } else if (part.functionCall) {
          textParts.push(`\n[Called Tool: ${part.functionCall.name} with arguments: ${JSON.stringify(part.functionCall.args || {})}]\n`);
        } else if (part.functionResponse) {
          const res = part.functionResponse.response?.result !== undefined ? part.functionResponse.response.result : part.functionResponse.response;
          textParts.push(`\n[Tool Response for ${part.functionResponse.name}: ${JSON.stringify(cleanToolResponse(res))}]\n`);
        } else if (part.inlineData && part.inlineData.data) {
          // Multimodal: image or media asset passed as native inlineData part
          parts.push({
            inlineData: {
              mimeType: part.inlineData.mimeType || "image/jpeg",
              data: part.inlineData.data
            }
          });
        }
      }

      if (textParts.length > 0) {
        parts.unshift({ text: textParts.join("") });
      }

      if (parts.length > 0) {
        const role = (currentMessage.role === "model" || currentMessage.role === "assistant") ? "model" : "user";
        liveTurns.push({ role, parts });
      }
    }

    // Per-turn episodic WebSocket connection
    const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${apiKey}`;
    console.log(`[Gemini Live] Connecting to WebSocket: wss://generativelanguage.googleapis.com/... (Key length: ${apiKey.length})`);
    console.log(`[Gemini Live] Target model: ${targetModel}`);

    const ws = new WebSocket(wsUrl);

    // Generator queue bridging push-based WebSocket events to async iterable
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

    if (abortSignal) {
      if (abortSignal.aborted) {
        try { ws.close(); } catch (_) {}
        throw new Error("Stream aborted by user");
      }
      abortSignal.addEventListener("abort", () => {
        console.log("[Gemini Live] Abort signal received, closing socket.");
        try { ws.close(); } catch (_) {}
        setError(new Error("Generation aborted by user"));
      }, { once: true });
    }

    const audioChunks = [];
    let audioMimeType = null;
    let isWavSaved = false;

    async function flushAudio() {
      if (audioChunks.length === 0 || isWavSaved) return;
      isWavSaved = true;
      try {
        let sampleRate = 24000;
        if (audioMimeType) {
          const match = audioMimeType.match(/rate=(\d+)/);
          if (match) sampleRate = parseInt(match[1], 10);
        }
        const wavBlob = createWavBlob(audioChunks, sampleRate);
        const wavDataUrl = await blobToDataURL(wavBlob);
        pushChunk({ type: "media", localPath: wavDataUrl, mimeType: "audio/wav" });
      } catch (mediaErr) {
        console.error("[Gemini Live] Failed to build audio WAV blob:", mediaErr);
      }
      audioChunks.length = 0;
    }

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
          }
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

        // Send user content turn only AFTER server confirms setup is complete
        if (parsed.setupComplete !== undefined) {
          console.log("[Gemini Live] Setup complete confirmed by server.");
          if (liveTurns.length > 0) {
            const clientContentMsg = {
              clientContent: {
                turns: liveTurns,
                turnComplete: true
              }
            };
            console.log("[Gemini Live] Outgoing clientContent frame:", JSON.stringify(clientContentMsg).substring(0, 200) + "...");
            ws.send(JSON.stringify(clientContentMsg));
          } else {
            finish();
          }
          return;
        }

        if (parsed.error) {
          console.error("[Gemini Live] Server error received:", parsed.error);
          const socketErr = new Error(`Gemini Live Error (${parsed.error.code || 'API'}): ${parsed.error.message || JSON.stringify(parsed.error)}`);
          setError(socketErr);
          try { ws.close(); } catch (_) {}
          return;
        }

        let hasFunctionCall = false;

        // Handle thoughts, function calls, text, and pcm audio in modelTurn
        if (parsed.serverContent?.modelTurn?.parts) {
          for (const part of parsed.serverContent.modelTurn.parts) {
            if (part.thought) {
              const thoughtText = typeof part.thought === "string" ? part.thought : part.text;
              if (thoughtText) {
                pushChunk({ type: "thought", text: thoughtText });
              }
            } else if (part.functionCall) {
              hasFunctionCall = true;
              const callId = part.functionCall.id || ("call_" + Math.random().toString(36).substring(2, 8));
              pushChunk({
                type: "functionCall",
                name: part.functionCall.name,
                args: part.functionCall.args,
                callId
              });
            } else if (part.text) {
              pushChunk({ type: "text", text: part.text });
            } else if (part.inlineData?.data) {
              if (part.inlineData.mimeType && part.inlineData.mimeType.startsWith("audio/pcm")) {
                audioChunks.push(base64ToUint8Array(part.inlineData.data));
                audioMimeType = part.inlineData.mimeType;
              }
            }
          }
        }

        // Top-level toolCall payload
        if (parsed.toolCall?.functionCalls) {
          hasFunctionCall = true;
          for (const fc of parsed.toolCall.functionCalls) {
            const callId = fc.id || ("call_" + Math.random().toString(36).substring(2, 8));
            pushChunk({
              type: "functionCall",
              name: fc.name,
              args: fc.args,
              callId
            });
          }
        }

        // Handle speech transcription
        if (parsed.serverContent?.outputTranscription?.text) {
          pushChunk({ type: "text", text: parsed.serverContent.outputTranscription.text });
        }

        // When a function call is requested, flush any spoken audio, complete current turn and close socket.
        // The outer execution loop in index.html will execute the tool and invoke stream() for the next turn.
        if (hasFunctionCall) {
          console.log("[Gemini Live] Tool call detected, completing current turn.");
          await flushAudio();
          try { ws.close(); } catch (_) {}
          finish();
          return;
        }

        // Turn completed normally
        if (parsed.serverContent?.turnComplete) {
          console.log("[Gemini Live] Server turnComplete flag received.");
          await flushAudio();
          try { ws.close(); } catch (_) {}
          finish();
        }
      } catch (err) {
        console.error("[Gemini Live] Error handling incoming socket frame:", err);
      }
    };

    ws.onerror = (err) => {
      console.error("[Gemini Live] WebSocket client error:", err);
      const socketErr = new Error("Gemini Live WebSocket connection failed. Please check your Gemini API key and network.");
      setError(socketErr);
    };

    ws.onclose = async (event) => {
      console.log(`[Gemini Live] WebSocket closed (Code: ${event.code}, Reason: ${event.reason || 'none'}).`);
      await flushAudio();
      if (event.code !== 1000 && !isFinished) {
        setError(new Error(`Gemini Live connection closed (Code ${event.code}${event.reason ? `: ${event.reason}` : ''}).`));
      } else {
        finish();
      }
    };

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
      try {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      } catch (_) {}
    }
  }
};
