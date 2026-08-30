import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export function createBuiltinMcpServer(deps) {
  const server = new Server(
    { name: "builtin-tools", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'list_dir',
          description: 'Lists files and directory structures inside paths. All paths are relative to your session workspace root.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Relative path within your session workspace (e.g. "workspace_mirror/myproject/src", "uploads").' }
            },
            required: ['path']
          }
        },
        {
          name: 'read_file',
          description: 'Reads contents of file, supporting pagination. Returns the content and the total line count of the file.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Relative path to the target file within your session workspace (e.g. "workspace_mirror/myproject/index.html" or "uploads/abc_doc.pdf").' },
              from_line: { type: 'integer', description: 'First line index target. Use negative values to count from the end of the file (e.g., -1 is the last line).' },
              to_line: { type: 'integer', description: 'End line index target. Use negative values to count from the end of the file (e.g., -1 is the last line).' }
            },
            required: ['path']
          }
        },
        {
          name: 'write_file',
          description: 'Creates a new file or completely overwrites an existing file. Use ONLY for creating new files or when replacing the entire content. For editing existing files, use edit_file instead.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Relative path within your session workspace (e.g. "workspace_mirror/myproject/new_file.js").' },
              content: { type: 'string', description: 'Complete file contents to write.' }
            },
            required: ['path', 'content']
          }
        },
        {
          name: 'edit_file',
          description: 'Patches an existing file using a search-block / replace-block strategy. Finds an exact occurrence of `search` in the file and replaces it with `replace`. Prefer this over write_file when editing existing files — only the changed section needs to be specified. The `search` block must exactly match the file content including whitespace and indentation. Use `occurrence` to target a specific match when the same block appears multiple times.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Relative path within your session workspace to the file to patch (e.g. "workspace_mirror/myproject/src/index.js").' },
              search: { type: 'string', description: 'The exact text block to find in the file. Must match character-for-character.' },
              replace: { type: 'string', description: 'The replacement text that will substitute the matched search block.' },
              occurrence: { type: 'integer', description: 'Which occurrence to replace when there are multiple matches (1-based, default 1).' }
            },
            required: ['path', 'search', 'replace']
          }
        },
        {
          name: 'execute_command',
          description: 'Spawns terminal actions asynchronously. Outputs write continuously inside logs. Returns a terminal_id and a relative log_file path you can read with read_file.',
          inputSchema: {
            type: 'object',
            properties: {
              command: { type: 'string', description: 'The terminal command to run.' },
              path: { type: 'string', description: 'Relative path within your session workspace where the command should run (e.g. "workspace_mirror/myproject").' },
              name: { type: 'string', description: 'An optional descriptive name for the terminal session.' }
            },
            required: ['command', 'path']
          }
        },
        {
          name: 'regex_search',
          description: 'Searches for a regular expression in file names or file contents within specified paths.',
          inputSchema: {
            type: 'object',
            properties: {
              regexStr: { type: 'string', description: 'The regular expression to search for.' },
              paths: { type: 'array', items: { type: 'string' }, description: 'The paths to search within.' },
              options: {
                type: 'object',
                properties: {
                  searchFileName: { type: 'boolean', description: 'Whether to search in file names.' },
                  searchFileContent: { type: 'boolean', description: 'Whether to search in file contents.' }
                },
                description: 'Search options.'
              }
            },
            required: ['regexStr', 'paths']
          }
        },
        {
          name: 'send_terminal_input',
          description: 'Sends keyboard input or ASCII/escape sequences to a running terminal session\'s stdin. Useful for answering interactive prompts (e.g. y/n), sending Enter, Escape, Ctrl+C to interrupt, Ctrl+D to signal EOF, or any arbitrary text.',
          inputSchema: {
            type: 'object',
            properties: {
              terminal_id: { type: 'string', description: 'The target terminal session ID returned from execute_command.' },
              input: { type: 'string', description: 'The input string to write to terminal stdin.' }
            },
            required: ['terminal_id', 'input']
          }
        },
        {
          name: 'wait',
          description: 'Pauses active stream model turns for processing tasks.',
          inputSchema: {
            type: 'object',
            properties: {
              seconds: { type: 'integer', description: 'Seconds count to pause.' }
            },
            required: ['seconds']
          }
        },
        {
          name: 'wait_terminal',
          description: 'Awaits complete background program outputs or logs.',
          inputSchema: {
            type: 'object',
            properties: {
              terminal_id: { type: 'string', description: 'Target terminal tracking process ID.' },
              timeout_seconds: { type: 'integer', description: 'Max check timeout seconds (Default 10).' }
            },
            required: ['terminal_id']
          }
        },
        {
          name: 'terminate_terminal',
          description: 'Immediately kills running terminal tasks.',
          inputSchema: {
            type: 'object',
            properties: {
              terminal_id: { type: 'string', description: 'Active terminal target ID.' }
            },
            required: ['terminal_id']
          }
        },
        {
          name: 'set_session_name',
          description: 'Renames the current active chat window title dynamically.',
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Fresh chat title string.' }
            },
            required: ['name']
          }
        },
        {
          name: 'parse_document',
          description: 'Converts a document (PDF, Word, Excel, PowerPoint, Text, HTML, CSV) to Markdown and extracts any embedded images.',
          inputSchema: {
            type: 'object',
            properties: {
              filepath: { type: 'string', description: 'Relative path within your session workspace to the document file (e.g. "uploads/abc_report.pdf").' },
              outputName: { type: 'string', description: 'Optional custom name for the output folder and Markdown file.' }
            },
            required: ['filepath']
          }
        },
        {
          name: 'view_image',
          description: 'Loads an image file (PNG, JPEG, WEBP, GIF, etc.) at the specified path and injects it directly inline into your multimodal context.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Relative path within your session workspace to the image file (e.g. "uploads/abc_photo.png").' }
            },
            required: ['path']
          }
        },
        {
          name: 'spawn_sub_agent',
          description: 'Spawns a new sub-AI agent asynchronously in the background. It will execute the given prompt using the specified instruction profile name (optional) without inheriting the parent prompt history.',
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'A short descriptive name for the sub-agent task.' },
              prompt: { type: 'string', description: 'The prompt/task description for the sub-agent to solve.' },
              instruction_profile_id: { type: 'string', description: 'Optional instruction profile ID. Defaults to standard Antigravity instructions if omitted.' }
            },
            required: ['name', 'prompt']
          }
        },
        {
          name: 'get_sub_agent_status',
          description: 'Checks the current execution status, recent chat history, and final output result of a previously spawned sub-agent.',
          inputSchema: {
            type: 'object',
            properties: {
              sub_agent_id: { type: 'string', description: 'The unique ID returned by spawn_sub_agent.' },
              max_recent_chars: { type: 'integer', description: 'Optional limit on returned history text size. Default is 4000.' }
            },
            required: ['sub_agent_id']
          }
        },
        {
          name: 'wait_sub_agent',
          description: 'Blocks and waits until the target sub-agent completes its execution. Returns the final status and output result.',
          inputSchema: {
            type: 'object',
            properties: {
              sub_agent_id: { type: 'string', description: 'The unique ID returned by spawn_sub_agent.' }
            },
            required: ['sub_agent_id']
          }
        },
        {
          name: 'list_devices',
          description: 'Lists all available virtual or physical devices (e.g., adb android devices, local desktop environment, active browsers).',
          inputSchema: {
            type: 'object',
            properties: {}
          }
        },
        {
          name: 'get_device_visuals',
          description: 'Captures the current visual display of the specified device. Returns both a raw screenshot and a screenshot overlayed with a high-contrast coordinate grid.',
          inputSchema: {
            type: 'object',
            properties: {
              deviceId: { type: 'string', description: 'The unique ID of the target device.' }
            },
            required: ['deviceId']
          }
        },
        {
          name: 'device_click',
          description: 'Performs a mouse click or screen tap on the specified device at the given coordinates.',
          inputSchema: {
            type: 'object',
            properties: {
              deviceId: { type: 'string', description: 'The unique ID of the target device.' },
              x: { type: 'integer', description: 'The X coordinate.' },
              y: { type: 'integer', description: 'The Y coordinate.' }
            },
            required: ['deviceId', 'x', 'y']
          }
        },
        {
          name: 'device_keyboard',
          description: 'Emulates keyboard input on the target device, typing text or sending key events.',
          inputSchema: {
            type: 'object',
            properties: {
              deviceId: { type: 'string', description: 'The unique ID of the target device.' },
              text: { type: 'string', description: 'Text to type into the active input field.' }
            },
            required: ['deviceId', 'text']
          }
        },
        {
          name: 'device_swipe',
          description: 'Performs a swipe or drag gesture on the target device from a starting coordinate to an ending coordinate.',
          inputSchema: {
            type: 'object',
            properties: {
              deviceId: { type: 'string', description: 'The unique ID of the target device.' },
              fromX: { type: 'integer', description: 'Starting X coordinate.' },
              fromY: { type: 'integer', description: 'Starting Y coordinate.' },
              toX: { type: 'integer', description: 'Ending X coordinate.' },
              toY: { type: 'integer', description: 'Ending Y coordinate.' },
              duration: { type: 'integer', description: 'Duration of the swipe event in milliseconds (default 300).' }
            },
            required: ['deviceId', 'fromX', 'fromY', 'toX', 'toY']
          }
        },
        {
          name: 'device_navigate',
          description: 'Directs the target device to navigate to the specified URL.',
          inputSchema: {
            type: 'object',
            properties: {
              deviceId: { type: 'string', description: 'The unique ID of the target device.' },
              url: { type: 'string', description: 'The URL to open/navigate to.' }
            },
            required: ['deviceId', 'url']
          }
        },
        {
          name: 'device_scroll',
          description: 'Emulates scrolling on the target device starting at a specific coordinate position.',
          inputSchema: {
            type: 'object',
            properties: {
              deviceId: { type: 'string', description: 'The unique ID of the target device.' },
              x: { type: 'integer', description: 'The X coordinate where the scroll starts.' },
              y: { type: 'integer', description: 'The Y coordinate where the scroll starts.' },
              deltaX: { type: 'integer', description: 'Horizontal scroll distance (positive: right, negative: left).' },
              deltaY: { type: 'integer', description: 'Vertical scroll distance (positive: down, negative: up).' }
            },
            required: ['deviceId', 'x', 'y', 'deltaX', 'deltaY']
          }
        }
      ]
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const { workspaceId, sessionId } = args;

    try {
      let toolResult;
      if (name === 'list_dir') {
        toolResult = await deps.listDirTool(workspaceId, sessionId, args.path);
      } else if (name === 'read_file') {
        toolResult = await deps.readFileTool(workspaceId, sessionId, args.path, args.from_line, args.to_line);
      } else if (name === 'write_file') {
        toolResult = await deps.writeFileTool(workspaceId, sessionId, args.path, args.content);
      } else if (name === 'edit_file') {
        toolResult = await deps.editFileTool(workspaceId, sessionId, args.path, args.search, args.replace, args.occurrence ?? 1);
      } else if (name === 'execute_command') {
        toolResult = await deps.executeCommandTool(workspaceId, sessionId, args.command, args.path, args.name);
      } else if (name === 'regex_search') {
        toolResult = await deps.regexSearchTool(workspaceId, sessionId, args.regexStr, args.paths, args.options);
      } else if (name === 'send_terminal_input') {
        toolResult = await deps.sendTerminalInputTool(args.terminal_id, args.input);
      } else if (name === 'wait') {
        toolResult = await deps.waitTool(args.seconds);
      } else if (name === 'wait_terminal') {
        toolResult = await deps.waitTerminalTool(args.terminal_id, args.timeout_seconds);
      } else if (name === 'terminate_terminal') {
        toolResult = await deps.terminateTerminalTool(args.terminal_id);
      } else if (name === 'set_session_name') {
        toolResult = await deps.setSessionNameTool(sessionId, args.name);
      } else if (name === 'parse_document') {
        toolResult = await deps.parseDocumentTool(workspaceId, sessionId, args.filepath, args.outputName);
      } else if (name === 'view_image') {
        toolResult = await deps.viewImageTool(workspaceId, sessionId, args.path);
      } else if (name === 'spawn_sub_agent') {
        toolResult = await deps.spawnSubAgentTool(workspaceId, sessionId, args.name, args.prompt, args.instruction_profile_id);
      } else if (name === 'get_sub_agent_status') {
        toolResult = await deps.getSubAgentStatusTool(workspaceId, sessionId, args.sub_agent_id, args.max_recent_chars);
      } else if (name === 'wait_sub_agent') {
        toolResult = await deps.waitSubAgentTool(workspaceId, sessionId, args.sub_agent_id);
      } else if (name === 'list_devices') {
        toolResult = await deps.deviceManager.listDevices();
      } else if (name === 'get_device_visuals') {
        const adapter = deps.deviceManager.getAdapter(args.deviceId);
        if (!adapter) {
          toolResult = { error: `Device adapter not found for ID: ${args.deviceId}` };
        } else {
          const rawBuffer = await adapter.getScreenshot();
          const sideBySideBuffer = await deps.createVisualGrid(rawBuffer);
          toolResult = {
            success: true,
            message: "Screen captured successfully. Grid overlay has been injected into context.",
            inlineImage: {
              data: sideBySideBuffer.toString('base64'),
              mimeType: 'image/png'
            }
          };
        }
      } else if (name === 'device_click') {
        const adapter = deps.deviceManager.getAdapter(args.deviceId);
        if (!adapter) {
          toolResult = { error: `Device adapter not found for ID: ${args.deviceId}` };
        } else {
          await adapter.click(args.x, args.y);
          toolResult = { success: true };
        }
      } else if (name === 'device_keyboard') {
        const adapter = deps.deviceManager.getAdapter(args.deviceId);
        if (!adapter) {
          toolResult = { error: `Device adapter not found for ID: ${args.deviceId}` };
        } else {
          await adapter.type(args.text);
          toolResult = { success: true };
        }
      } else if (name === 'device_swipe') {
        const adapter = deps.deviceManager.getAdapter(args.deviceId);
        if (!adapter) {
          toolResult = { error: `Device adapter not found for ID: ${args.deviceId}` };
        } else {
          await adapter.swipe(args.fromX, args.fromY, args.toX, args.toY, args.duration || 300);
          toolResult = { success: true };
        }
      } else if (name === 'device_navigate') {
        const adapter = deps.deviceManager.getAdapter(args.deviceId);
        if (!adapter) {
          toolResult = { error: `Device adapter not found for ID: ${args.deviceId}` };
        } else {
          await adapter.navigate(args.url);
          toolResult = { success: true };
        }
      } else if (name === 'device_scroll') {
        const adapter = deps.deviceManager.getAdapter(args.deviceId);
        if (!adapter) {
          toolResult = { error: `Device adapter not found for ID: ${args.deviceId}` };
        } else {
          await adapter.scroll(args.x, args.y, args.deltaX, args.deltaY);
          toolResult = { success: true };
        }
      } else {
        throw new Error(`Tool not found: ${name}`);
      }

      return {
        content: [{ type: "text", text: JSON.stringify(toolResult, null, 2) }]
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error executing ${name}: ${error.message}` }]
      };
    }
  });

  return server;
}
