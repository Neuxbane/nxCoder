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
  async *stream({ apiKey, baseUrl, model, temperature, messages, tools, abortSignal }) {
    const cleanBaseUrl = (baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
    const headers = {
      "Content-Type": "application/json"
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const payload = {
      model: model || "gpt-4o",
      messages: messages,
      stream: true
    };
    if (temperature !== undefined) {
      payload.temperature = Number(temperature);
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

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "data: [DONE]") continue;
        if (trimmed.startsWith("data: ")) {
          try {
            const data = JSON.parse(trimmed.slice(6));
            const delta = data.choices?.[0]?.delta;
            if (delta?.reasoning_content) {
              yield { type: "thought", text: delta.reasoning_content };
            }
            if (delta?.content) {
              yield { type: "text", text: delta.content };
            }
          } catch (e) {
            // Ignore parse errors on individual SSE chunks
          }
        }
      }
    }
  }
};
