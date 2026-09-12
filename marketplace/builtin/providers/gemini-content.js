// Convert native conversation parts to the Interactions API step format.
export function mapContentStackToSteps(contentStack) {
  const steps = [];
  for (const turn of contentStack) {
    if (turn.role === 'user') {
      const userInputContent = [];
      for (const part of turn.parts) {
        if (part.functionResponse) {
          if (userInputContent.length > 0) {
            steps.push({
              type: 'user_input',
              content: [...userInputContent]
            });
            userInputContent.length = 0;
          }
          steps.push({
            type: 'function_result',
            call_id: part.functionResponse.id,
            name: part.functionResponse.name,
            result: part.functionResponse.response?.result ?? part.functionResponse.response
          });
        } else if (part.text) {
          userInputContent.push({ type: 'text', text: part.text });
        } else if (part.inlineData) {
          userInputContent.push({
            type: 'image',
            data: part.inlineData.data,
            mime_type: part.inlineData.mimeType
          });
        }
      }
      if (userInputContent.length > 0) {
        steps.push({
          type: 'user_input',
          content: userInputContent
        });
      }
    } else if (turn.role === 'model') {
      for (const part of turn.parts) {
        if (part.functionCall) {
          steps.push({
            type: 'function_call',
            id: part.functionCall.id,
            name: part.functionCall.name,
            arguments: part.functionCall.args
          });
        } else if (part.text) {
          steps.push({
            type: 'model_output',
            content: [{ type: 'text', text: part.text }]
          });
        }
      }
    }
  }
  return steps;
}
