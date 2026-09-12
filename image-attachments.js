import fs from 'node:fs/promises';
import path from 'node:path';
import mime from 'mime';

// Read original bytes: thumbnail sizing must never affect model input.
export async function loadAttachedImage(part) {
  const mimeType = part.mimeType?.startsWith('image/') ? part.mimeType : mime.getType(part._localFilePath);
  if (!mimeType?.startsWith('image/')) return null;
  try {
    const data = await fs.readFile(part._localFilePath, 'base64');
    return { inlineData: { mimeType, data } };
  } catch {
    return { text: `[Attached image ${JSON.stringify(path.basename(part._localFilePath))} could not be read. Do not infer its contents; ask the user to reattach it if needed.]` };
  }
}

// Live reconnects for each execution; restore visual context along with text history.
export function getHistoryImages(messages) {
  return messages.flatMap((message, turn) => message.parts.flatMap((part, index) =>
    part.inlineData?.mimeType?.startsWith('image/') ? [
      { text: `[Image from conversation turn ${turn + 1}, ${message.role}, attachment ${index + 1}]` },
      { inlineData: { ...part.inlineData } }
    ] : []));
}
