// Google Gemini Provider Extension

function cleanToolResponse(resp) {
  if (!resp || typeof resp !== "object") return resp;
  try {
    const clone = JSON.parse(JSON.stringify(resp));
    const clean = (obj) => {
      if (!obj || typeof obj !== "object") return;
      for (const k of Object.keys(obj)) {
        if (k === "inlineImage" || k === "inlineData") {
          obj[k] = "[image binary data]";
        } else if (k === "data" && typeof obj[k] === "string" && obj[k].length > 200) {
          obj[k] = "[binary data]";
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
  id: "gemini",
  name: "Google Gemini",
  description: "Official Google Gemini API supporting streaming, reasoning, and tool configurations.",
  
  requirements: [
    { key: "apiKey", label: "Gemini API Key", type: "password", required: true, placeholder: "AIzaSy..." },
    { key: "model", label: "Model Identifier", type: "text", required: true, default: "gemini-2.5-flash", placeholder: "gemini-2.5-flash, gemini-2.0-flash, gemini-2.5-pro" },
    { key: "temperature", label: "Temperature", type: "number", required: false, default: 0.7, min: 0, max: 2, step: 0.1 }
  ],

  async *stream({ apiKey, model, temperature, messages, tools, systemInstruction, abortSignal }) {
    const targetModel = model || "gemini-2.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:streamGenerateContent?alt=sse&key=${apiKey}`;

    // Convert messages to Gemini format
    const contents = (messages || []).map(m => {
      let parts = [];
      if (Array.isArray(m.parts)) {
        parts = m.parts.map(p => {
          if (p.functionCall) {
            return {
              functionCall: {
                name: p.functionCall.name,
                args: p.functionCall.args || {}
              }
            };
          } else if (p.functionResponse) {
            const rawResp = typeof p.functionResponse.response === 'object' && p.functionResponse.response !== null
              ? p.functionResponse.response
              : { result: p.functionResponse.response };
            return {
              functionResponse: {
                name: p.functionResponse.name,
                response: cleanToolResponse(rawResp)
              }
            };
          } else if (p.inlineData) {
            return {
              inlineData: {
                mimeType: p.inlineData.mimeType,
                data: p.inlineData.data
              }
            };
          } else if (p.text) {
            return { text: p.text };
          }
          return { text: typeof p === 'string' ? p : JSON.stringify(p) };
        });
      } else if (typeof m.content === "string") {
        parts = [{ text: m.content }];
      } else if (Array.isArray(m.content)) {
        parts = m.content.map(c => typeof c === "string" ? { text: c } : { text: c.text || JSON.stringify(c) });
      } else {
        parts = [{ text: JSON.stringify(m.content || "") }];
      }

      return {
        role: m.role === "assistant" || m.role === "model" ? "model" : "user",
        parts
      };
    });

    const requestBody = {
      contents,
      generationConfig: {
        temperature: temperature !== undefined ? Number(temperature) : 0.7
      }
    };

    if (systemInstruction) {
      requestBody.systemInstruction = {
        parts: [{ text: typeof systemInstruction === 'string' ? systemInstruction : JSON.stringify(systemInstruction) }]
      };
    }

    if (tools && tools.length > 0) {
      requestBody.tools = [{
        functionDeclarations: tools.map(t => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters || t.inputSchema || { type: "object", properties: {} }
        }))
      }];
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: abortSignal
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API Error (${response.status}): ${errText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        try {
          const data = JSON.parse(trimmed.slice(6));
          const candidate = data.candidates?.[0];
          const parts = candidate?.content?.parts || [];
          for (const part of parts) {
            if (part.thought) {
              yield { type: "thought", text: part.text || part.thought };
            } else if (part.functionCall) {
              yield {
                type: "functionCall",
                name: part.functionCall.name,
                args: part.functionCall.args,
                callId: part.functionCall.id || ("call_" + Math.random().toString(36).substring(2, 8))
              };
            } else if (part.text) {
              yield { type: "text", text: part.text };
            }
          }
          if (candidate?.finishReason) {
            try { reader.cancel(); } catch(e) {}
            return;
          }
        } catch (e) {}
      }
    }
  }
};
