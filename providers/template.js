// Custom Model Provider Extension Template
// You can customize the requirements and stream generator function below!
export default {
  id: "my-custom-provider",
  name: "My Custom Provider",
  description: "A custom provider extension script for nxCoder.",
  
  // Define what inputs the user must provide to create a model instance
  requirements: [
    { 
      key: "apiKey", 
      label: "API Key", 
      type: "password", 
      required: false, 
      placeholder: "sk-..." 
    },
    { 
      key: "baseUrl", 
      label: "Endpoint Base URL", 
      type: "text", 
      required: true, 
      default: "https://api.example.com/v1", 
      placeholder: "https://api.example.com/v1" 
    },
    { 
      key: "model", 
      label: "Model Identifier", 
      type: "text", 
      required: true, 
      default: "custom-model", 
      placeholder: "custom-model" 
    },
    { 
      key: "temperature", 
      label: "Temperature", 
      type: "number", 
      required: false, 
      default: 0.7, 
      min: 0, 
      max: 2, 
      step: 0.1 
    }
  ],

  // Execution generator: yields chunks { type: 'text'|'thought', text: string }
  async *stream({ apiKey, baseUrl, model, temperature, messages, tools, abortSignal }) {
    // 1. Prepare your request headers and payload
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    // 2. Make the HTTP request
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages,
        temperature: Number(temperature) || 0.7,
        stream: true
      }),
      signal: abortSignal
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Custom Provider Error (${response.status}): ${err}`);
    }

    // 3. Read and decode the stream
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
          } catch (e) {}
        }
      }
    }
  }
};
