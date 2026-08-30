function truncateMiddle(str, maxLength = 2500) {
  if (typeof str !== "string" || str.length <= maxLength) return str;
  const half = Math.floor(maxLength / 2);
  const tail = maxLength - half;
  return str.substring(0, half) + `\n... [truncated ${str.length - maxLength} characters] ...\n` + str.substring(str.length - tail);
}

// OpenAI-Compatible Provider Extension (OpenAI, DeepSeek, Groq, OpenRouter, LM Studio, vLLM)
export default {
  id: "openai-compatible",
  name: "OpenAI Compatible",
  description: "Standard OpenAI Chat Completions API. Works with OpenAI, DeepSeek, Groq, OpenRouter, Local vLLM, and LM Studio.",
  
  // Fields required when creating a model instance
  requirements: [
    { key: "apiKey", label: "API Key", type: "password", required: false, placeholder: "sk-... (leave empty for local models)" },
    { key: "baseUrl", label: "Base URL", type: "text", required: true, default: "https://api.openai.com/v1", placeholder: "https://api.openai.com/v1 or http://localhost:1234/v1" },
    { key: "model", label: "Model Identifier", type: "text", required: true, default: "gpt-4o", placeholder: "gpt-4o, deepseek-chat, llama-3.3-70b" },
    { key: "temperature", label: "Temperature", type: "number", required: false, default: 0.7, min: 0, max: 2, step: 0.1 }
  ],

  // Execution stream handler
  async *stream({ apiKey, baseUrl, model, temperature, systemInstruction, messages, tools, abortSignal }) {
    const cleanBaseUrl = (baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
    const headers = {
      "Content-Type": "application/json"
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const formattedMessages = [];
    if (systemInstruction) {
      const sysContent = typeof systemInstruction === 'string' ? systemInstruction : JSON.stringify(systemInstruction);
      formattedMessages.push({ role: 'system', content: sysContent });
    }

    for (const m of (messages || [])) {
      if (m.role === 'system' && systemInstruction) continue;
      if (typeof m.content === "string") {
        formattedMessages.push(m);
        continue;
      }
      if (Array.isArray(m.parts)) {
        let textParts = [];
        let contentArr = [];
        let toolCalls = [];
        let hasToolResp = false;

        for (const p of m.parts) {
          if (p.text) {
            textParts.push(p.text);
            contentArr.push({ type: "text", text: p.text });
          } else if (p.inlineData) {
            contentArr.push({
              type: "image_url",
              image_url: {
                url: `data:${p.inlineData.mimeType || 'image/jpeg'};base64,${p.inlineData.data}`
              }
            });
          } else if (p.functionCall) {
            toolCalls.push({
              id: p.functionCall.id || ("call_" + Math.random().toString(36).substring(2, 8)),
              type: "function",
              function: {
                name: p.functionCall.name,
                arguments: JSON.stringify(p.functionCall.args || {})
              }
            });
          } else if (p.functionResponse) {
            hasToolResp = true;
            const res = p.functionResponse.response?.result !== undefined ? p.functionResponse.response.result : p.functionResponse.response;
            const rawContent = typeof res === 'string' ? res : JSON.stringify(res);
            formattedMessages.push({
              role: "tool",
              tool_call_id: p.functionResponse.id,
              content: truncateMiddle(rawContent)
            });
          }
        }

        if (hasToolResp) continue;

        if (toolCalls.length > 0) {
          formattedMessages.push({
            role: "assistant",
            content: textParts.join("") || null,
            tool_calls: toolCalls
          });
        } else if (contentArr.length > 0) {
          formattedMessages.push({
            role: m.role === "assistant" || m.role === "model" ? "assistant" : "user",
            content: contentArr.length === 1 && contentArr[0].type === "text" ? contentArr[0].text : contentArr
          });
        }
      } else {
        formattedMessages.push(m);
      }
    }

    const payload = {
      model: model || "gpt-4o",
      messages: formattedMessages,
      stream: true
    };
    if (temperature !== undefined) {
      payload.temperature = Number(temperature);
    }
    if (tools && tools.length > 0) {
      payload.tools = tools.map(t => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters || { type: "object", properties: {} }
        }
      }));
    }

    const response = await fetch(`${cleanBaseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: abortSignal
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI API Error (${response.status}): ${errText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const activeToolCalls = {};

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed === "data: [DONE]") {
          try { reader.cancel(); } catch(e) {}
          return;
        }
        if (trimmed.startsWith("data: ")) {
          try {
            const data = JSON.parse(trimmed.slice(6));
            const choice = data.choices?.[0];
            const delta = choice?.delta;
            if (delta?.reasoning_content) {
              yield { type: "thought", text: delta.reasoning_content };
            }
            if (delta?.content) {
              yield { type: "text", text: delta.content };
            }
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index !== undefined ? tc.index : 0;
                if (!activeToolCalls[idx]) {
                  activeToolCalls[idx] = {
                    id: tc.id || ("call_" + Math.random().toString(36).substring(2, 8)),
                    name: tc.function?.name || "",
                    arguments: ""
                  };
                }
                if (tc.id) activeToolCalls[idx].id = tc.id;
                if (tc.function?.name) activeToolCalls[idx].name = tc.function.name;
                if (tc.function?.arguments) activeToolCalls[idx].arguments += tc.function.arguments;
              }
            }
            if (choice?.finish_reason) {
              for (const idx of Object.keys(activeToolCalls)) {
                const tc = activeToolCalls[idx];
                let args = {};
                try { args = JSON.parse(tc.arguments || "{}"); } catch(e) {}
                yield {
                  type: "functionCall",
                  name: tc.name,
                  args: args,
                  callId: tc.id
                };
              }
              try { reader.cancel(); } catch(e) {}
              return;
            }
          } catch (e) {
            // Ignore parse errors on individual SSE chunks
          }
        }
      }
    }
  }
};
