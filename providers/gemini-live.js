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

function sanitizeForPrompt(val) {
  if (val === null || val === undefined) return "";
  if (typeof val === "string") {
    if (val.length > 300 && !val.includes(" ") && (val.startsWith("/9j/") || val.startsWith("iVBORw0KGgo") || val.startsWith("data:image/"))) {
      return "[image binary data]";
    }
    return val;
  }
  if (typeof val === "object") {
    try {
      const clone = JSON.parse(JSON.stringify(val));
      const cleanObj = (obj) => {
        if (!obj || typeof obj !== "object") return;
        for (const k of Object.keys(obj)) {
          if (k === "inlineImage" || k === "inlineData") {
            obj[k] = "[image binary data]";
          } else if (k === "data" && typeof obj[k] === "string" && obj[k].length > 200) {
            obj[k] = "[binary data]";
          } else if (typeof obj[k] === "object") {
            cleanObj(obj[k]);
          }
        }
      };
      cleanObj(clone);
      return JSON.stringify(clone);
    } catch (_) {
      return String(val);
    }
  }
  return String(val);
}

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

  async *stream({ apiKey, model, voice, thinking, systemInstruction, messages, tools, abortSignal }) {
    let targetModel = model || "gemini-2.5-flash";
    if (!targetModel.startsWith("models/")) {
      targetModel = `models/${targetModel}`;
    }

    const selectedVoice = voice || "Zephyr";

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

    const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${apiKey}`;

    console.log(`[Gemini Live] Connecting to WebSocket: wss://generativelanguage.googleapis.com/... (Key length: ${apiKey.length})`);
    console.log(`[Gemini Live] Target model: ${targetModel}`);
    if (effectiveSystemInstruction) {
      console.log(`[Gemini Live] System instruction attached (${effectiveSystemInstruction.length} chars)`);
    }

    const ws = new WebSocket(wsUrl);

    const messageQueue = [];
    let resolveNext = null;
    let isFinished = false;
    let socketError = null;
    let setupCompleted = false;
    let receivedAnyData = false;
    const audioChunks = [];
    let audioMimeType = null;

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

    // Append anti-echo directive to system instruction
    const antiEchoDirective = "\n\nImportant: You have access to real tools. When you receive [Tool Output], examine the data and proceed with your reasoning or next action. Do not echo internal '[Tool Executed]' or '[Tool Output]' tags in your final conversational response.";
    effectiveSystemInstruction = effectiveSystemInstruction ? (effectiveSystemInstruction + antiEchoDirective) : antiEchoDirective.trim();

    // 1. Separate historical messages from the current active turn
    const historyMessages = (messages || []).filter(m => m.role !== "system").slice(0, -1);
    const currentMessage = (messages || []).filter(m => m.role !== "system").slice(-1)[0];

    // 2. Format history into clean conversation context
    let historyString = "";
    if (historyMessages.length > 0) {
      historyString += "=== PREVIOUS CONVERSATION CONTEXT ===\n";
      for (const msg of historyMessages) {
        const role = msg.role === "model" || msg.role === "assistant" ? "Assistant" : "User";
        let msgText = "";
        if (Array.isArray(msg.parts)) {
          for (const part of msg.parts) {
            if (part.text) {
              msgText += part.text;
            } else if (part.functionCall) {
              msgText += `\n[Tool Executed: ${part.functionCall.name} with parameters ${JSON.stringify(part.functionCall.args || {})}]\n`;
            } else if (part.functionResponse) {
              const res = part.functionResponse.response?.result !== undefined ? part.functionResponse.response.result : part.functionResponse.response;
              msgText += `\n[Tool Output for ${part.functionResponse.name}]:\n${sanitizeForPrompt(res)}\n`;
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

    // 3. Build the outgoing turn
    const liveTurns = [];
    if (currentMessage) {
      const parts = [];
      const textParts = [];
      if (historyString.trim()) {
        textParts.push(historyString.trim() + "\n\n=== CURRENT INSTRUCTION ===\n");
      }

      if (Array.isArray(currentMessage.parts)) {
        for (const part of currentMessage.parts) {
          if (part.text) {
            textParts.push(part.text);
          } else if (part.functionResponse) {
            const res = part.functionResponse.response?.result !== undefined ? part.functionResponse.response.result : part.functionResponse.response;
            textParts.push(`\n[Tool Output for ${part.functionResponse.name}]:\n${sanitizeForPrompt(res)}\n\nUse this tool output to proceed with your work. Call the next tool if needed, or output your final response.`);
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
        liveTurns.push({ role: "user", parts });
      }
    }

    ws.onopen = () => {
      console.log("[Gemini Live] Connection opened successfully.");

      // Configure thinking level / budget
      const selectedThinking = (thinking || "HIGH").toUpperCase();
      let thinkingConfig;
      if (selectedThinking === "OFF") {
        thinkingConfig = { includeThoughts: false };
      } else {
        thinkingConfig = { includeThoughts: true };
      }

      const generationConfig = {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: selectedVoice
            }
          }
        },
        thinkingConfig
      };

      const setupMsg = {
        setup: {
          model: targetModel,
          generationConfig,
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
        let hasFunctionCall = false;
        if (parsed.serverContent?.modelTurn?.parts) {
          for (const part of parsed.serverContent.modelTurn.parts) {
            if (part.thought) {
              const thoughtText = typeof part.thought === "string" ? part.thought : part.text;
              if (thoughtText) {
                console.log("[Gemini Live] Thought chunk:", thoughtText.substring(0, 40) + "...");
                pushChunk({ type: "thought", text: thoughtText });
              }
            } else if (part.functionCall) {
              hasFunctionCall = true;
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
            } else if (part.inlineData) {
              if (part.inlineData.data) {
                audioChunks.push(base64ToUint8Array(part.inlineData.data));
                if (part.inlineData.mimeType) {
                  audioMimeType = part.inlineData.mimeType;
                }
              }
            }
          }
        }

        if (parsed.toolCall?.functionCalls) {
          hasFunctionCall = true;
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

        if (hasFunctionCall) {
          console.log("[Gemini Live] Tool call detected, completing current live stream turn.");
          try { ws.close(); } catch (_) {}
          finish();
          return;
        }

        // Handle output transcriptions (AUDIO modality text output)
        if (parsed.serverContent?.outputTranscription?.text) {
          const transText = parsed.serverContent.outputTranscription.text;
          console.log("[Gemini Live] Output transcription chunk:", transText.substring(0, 40) + "...");
          pushChunk({ type: "text", text: transText });
        }

        if (parsed.serverContent?.turnComplete) {
          console.log("[Gemini Live] Server turnComplete flag received.");
          if (audioChunks.length > 0) {
            try {
              let sampleRate = 24000;
              if (audioMimeType) {
                const match = audioMimeType.match(/rate=(\d+)/);
                if (match) {
                  sampleRate = parseInt(match[1], 10);
                }
              }
              const wavBlob = createWavBlob(audioChunks, sampleRate);
              const wavDataUrl = await blobToDataURL(wavBlob);
              pushChunk({
                type: "media",
                localPath: wavDataUrl,
                mimeType: "audio/wav"
              });
            } catch (mediaErr) {
              console.error("[Gemini Live] Failed to build audio WAV blob:", mediaErr);
            }
            audioChunks.length = 0;
          }
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
