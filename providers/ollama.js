// Ollama Provider Extension (Local / Remote Ollama Server)
export default {
  id: "ollama",
  name: "Ollama",
  description: "Native Ollama local streaming API for local open-source LLMs.",
  
  requirements: [
    { key: "baseUrl", label: "Ollama Server URL", type: "text", required: true, default: "http://localhost:11434", placeholder: "http://localhost:11434" },
    { key: "model", label: "Model Tag", type: "text", required: true, default: "llama3.3", placeholder: "llama3.3, qwen2.5-coder, mistral, deepseek-r1:8b" },
    { key: "temperature", label: "Temperature", type: "number", required: false, default: 0.7, min: 0, max: 2, step: 0.1 }
  ],

  async *stream({ baseUrl, model, temperature, messages, tools, abortSignal }) {
    const cleanBaseUrl = (baseUrl || "http://localhost:11434").replace(/\/+$/, "");

    // Format messages for Ollama /api/chat
    const formattedMessages = messages.map(m => ({
      role: m.role === "model" || m.role === "assistant" ? "assistant" : "user",
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content)
    }));

    const response = await fetch(`${cleanBaseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model || "llama3.3",
        messages: formattedMessages,
        stream: true,
        options: {
          temperature: temperature !== undefined ? Number(temperature) : 0.7
        }
      }),
      signal: abortSignal
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Ollama Error (${response.status}): ${errText}`);
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
        if (!trimmed) continue;
        try {
          const data = JSON.parse(trimmed);
          if (data.message?.content) {
            yield { type: "text", text: data.message.content };
          }
          if (data.done) {
            try { reader.cancel(); } catch(e) {}
            return;
          }
        } catch (e) {}
      }
    }
  }
};
