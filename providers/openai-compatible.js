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

    const formattedMessages = [...(messages || [])];
    if (systemInstruction) {
      const sysContent = typeof systemInstruction === 'string' ? systemInstruction : JSON.stringify(systemInstruction);
      if (!formattedMessages.some(m => m.role === 'system')) {
        formattedMessages.unshift({ role: 'system', content: sysContent });
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
