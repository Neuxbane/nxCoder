// Anthropic Claude Provider Extension
export default {
  id: "anthropic",
  name: "Anthropic Claude",
  description: "Official Anthropic API for Claude 3.5 Sonnet and Haiku models.",
  
  requirements: [
    { key: "apiKey", label: "Anthropic API Key", type: "password", required: true, placeholder: "sk-ant-..." },
    { key: "model", label: "Model Identifier", type: "text", required: true, default: "claude-3-5-sonnet-20241022", placeholder: "claude-3-5-sonnet-20241022, claude-3-5-haiku-20241022" },
    { key: "temperature", label: "Temperature", type: "number", required: false, default: 0.7, min: 0, max: 1, step: 0.1 }
  ],

  async *stream({ apiKey, model, temperature, systemInstruction, messages, tools, abortSignal }) {
    const formattedMessages = (messages || []).filter(m => m.role !== 'system').map(m => ({
      role: m.role === "assistant" || m.role === "model" ? "assistant" : "user",
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content)
    }));

    const reqBody = {
      model: model || "claude-3-5-sonnet-20241022",
      messages: formattedMessages,
      max_tokens: 4096,
      temperature: temperature !== undefined ? Number(temperature) : 0.7,
      stream: true
    };

    if (systemInstruction) {
      reqBody.system = typeof systemInstruction === 'string' ? systemInstruction : JSON.stringify(systemInstruction);
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "dangerously-allow-browser": "true"
      },
      body: JSON.stringify(reqBody),
      signal: abortSignal
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Anthropic API Error (${response.status}): ${errText}`);
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
          if (data.type === "content_block_delta" && data.delta?.text) {
            yield { type: "text", text: data.delta.text };
          }
          if (data.type === "message_stop" || (data.type === "message_delta" && data.delta?.stop_reason)) {
            try { reader.cancel(); } catch(e) {}
            return;
          }
        } catch (e) {}
      }
    }
  }
};
