import json
import glob
import os

# Translated JavaScript object to standard Python Dictionary / JSON
TOOLS_DEF = [
    {
        "functionDeclarations": [
            {
                "name": "list_dir",
                "description": "Lists files and directory structures inside paths. All paths are relative to your session workspace root.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "path": { "type": "STRING", "description": "Relative path within your session workspace (e.g. \"workspace_mirror/myproject/src\", \"uploads\")." }
                    },
                    "required": ["path"]
                }
            },
            {
                "name": "read_file",
                "description": "Reads contents of file, supporting pagination. Returns the content and the total line count of the file.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "path": { "type": "STRING", "description": "Relative path to the target file within your session workspace (e.g. \"workspace_mirror/myproject/index.html\" or \"uploads/abc_doc.pdf\")." },
                        "from_line": { "type": "INTEGER", "description": "First line index target. Use negative values to count from the end of the file (e.g., -1 is the last line)." },
                        "to_line": { "type": "INTEGER", "description": "End line index target. Use negative values to count from the end of the file (e.g., -1 is the last line)." }
                    },
                    "required": ["path"]
                }
            },
            {
                "name": "write_file",
                "description": "Creates a new file or completely overwrites an existing file. Use ONLY for creating new files or when replacing the entire content. For editing existing files, use edit_file instead.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "path": { "type": "STRING", "description": "Relative path within your session workspace (e.g. \"workspace_mirror/myproject/new_file.js\")." },
                        "content": { "type": "STRING", "description": "Complete file contents to write." }
                    },
                    "required": ["path", "content"]
                }
            },
            {
                "name": "edit_file",
                "description": "Patches an existing file using a search-block / replace-block strategy. Finds an exact occurrence of `search` in the file and replaces it with `replace`. Prefer this over write_file when editing existing files \u2014 only the changed section needs to be specified. The `search` block must exactly match the file content including whitespace and indentation. Use `occurrence` to target a specific match when the same block appears multiple times.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "path": { "type": "STRING", "description": "Relative path within your session workspace to the file to patch (e.g. \"workspace_mirror/myproject/src/index.js\")." },
                        "search": { "type": "STRING", "description": "The exact text block to find in the file. Must match character-for-character." },
                        "replace": { "type": "STRING", "description": "The replacement text that will substitute the matched search block." },
                        "occurrence": { "type": "INTEGER", "description": "Which occurrence to replace when there are multiple matches (1-based, default 1)." }
                    },
                    "required": ["path", "search", "replace"]
                }
            },
            {
                "name": "execute_command",
                "description": "Spawns terminal actions asynchronously. Outputs write continuously inside logs. Returns a terminal_id and a relative log_file path you can read with read_file.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "command": { "type": "STRING", "description": "The terminal command to run." },
                        "path": { "type": "STRING", "description": "Relative path within your session workspace where the command should run (e.g. \"workspace_mirror/myproject\")." },
                        "name": { "type": "STRING", "description": "An optional descriptive name for the terminal session." }
                    },
                    "required": ["command", "path"]
                }
            },
            {
                "name": "regex_search",
                "description": "Searches for a regular expression in file names or file contents within specified paths.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "regexStr": { "type": "STRING", "description": "The regular expression to search for." },
                        "paths": { "type": "ARRAY", "items": { "type": "STRING" }, "description": "The paths to search within." },
                        "options": {
                            "type": "OBJECT",
                            "properties": {
                                "searchFileName": { "type": "BOOLEAN", "description": "Whether to search in file names." },
                                "searchFileContent": { "type": "BOOLEAN", "description": "Whether to search in file contents." }
                            },
                            "description": "Search options."
                        }
                    },
                    "required": ["regexStr", "paths"]
                }
            },
            {
                "name": "send_terminal_input",
                "description": "Sends keyboard input or ASCII/escape sequences to a running terminal session's stdin. Useful for answering interactive prompts (e.g. y/n), sending Enter, Escape, Ctrl+C to interrupt, Ctrl+D to signal EOF, or any arbitrary text. Supports standard escape sequences: \\n (Enter/newline), \\r (carriage return), \\t (tab), \\e or \\x1b (Escape key), \\x03 (Ctrl+C / SIGINT), \\x04 (Ctrl+D / EOF), and arbitrary hex/unicode via \\xHH or \\uHHHH.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "terminal_id": { "type": "STRING", "description": "The target terminal session ID returned from execute_command." },
                        "input": { "type": "STRING", "description": "The input string to write to terminal stdin. Supports escape sequences: \\n (newline/Enter), \\r (carriage return), \\t (tab), \\e or \\x1b (Escape), \\x03 (Ctrl+C), \\x04 (Ctrl+D), \\xHH (arbitrary hex byte), \\uHHHH (unicode codepoint)." }
                    },
                    "required": ["terminal_id", "input"]
                }
            },
            {
                "name": "wait",
                "description": "Pauses active stream model turns for processing tasks.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "seconds": { "type": "INTEGER", "description": "Seconds count to pause." }
                    },
                    "required": ["seconds"]
                }
            },
            {
                "name": "wait_terminal",
                "description": "Awaits complete background program outputs or logs.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "terminal_id": { "type": "STRING", "description": "Target terminal tracking process ID." },
                        "timeout_seconds": { "type": "INTEGER", "description": "Max check timeout seconds (Default 10)." }
                    },
                    "required": ["terminal_id"]
                }
            },
            {
                "name": "terminate_terminal",
                "description": "Immediately kills running terminal tasks.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "terminal_id": { "type": "STRING", "description": "Active terminal target ID." }
                    },
                    "required": ["terminal_id"]
                }
            },
            {
                "name": "set_session_name",
                "description": "Renames the current active chat window title dynamically.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "name": { "type": "STRING", "description": "Fresh chat title string." }
                    },
                    "required": ["name"]
                }
            },
            {
                "name": "parse_document",
                "description": "Converts a document (PDF, Word, Excel, PowerPoint, Text, HTML, CSV) to Markdown and extracts any embedded images. The output is saved in a subfolder inside the session folder, containing the markdown file and the extracted images.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "filepath": { "type": "STRING", "description": "Relative path within your session workspace to the document file (e.g. \"uploads/abc_report.pdf\")." },
                        "outputName": { "type": "STRING", "description": "Optional custom name for the output folder and Markdown file. If not specified, the source file name (without extension) is used." }
                    },
                    "required": ["filepath"]
                }
            },
            {
                "name": "view_image",
                "description": "Loads an image file (PNG, JPEG, WEBP, GIF, etc.) at the specified path and injects it directly inline into your multimodal context so you can see/inspect it directly.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "path": { "type": "STRING", "description": "Relative path within your session workspace to the image file (e.g. \"uploads/abc_photo.png\" or \"workspace_mirror/myproject/assets/logo.svg\")." }
                    },
                    "required": ["path"]
                }
            },
            {
                "name": "list_devices",
                "description": "Lists all available virtual or physical devices (e.g., adb android devices, local desktop environment, active browsers).",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {}
                }
            },
            {
                "name": "get_device_visuals",
                "description": "Captures the current visual display of the specified device. Returns both a raw screenshot and a screenshot overlayed with a high-contrast coordinate grid.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "deviceId": { "type": "STRING", "description": "The unique ID of the target device." }
                    },
                    "required": ["deviceId"]
                }
            },
            {
                "name": "device_click",
                "description": "Performs a mouse click or screen tap on the specified device at the given coordinates.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "deviceId": { "type": "STRING", "description": "The unique ID of the target device." },
                        "x": { "type": "INTEGER", "description": "The X coordinate." },
                        "y": { "type": "INTEGER", "description": "The Y coordinate." }
                    },
                    "required": ["deviceId", "x", "y"]
                }
            },
            {
                "name": "device_keyboard",
                "description": "Emulates keyboard input on the target device, typing text or sending key events.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "deviceId": { "type": "STRING", "description": "The unique ID of the target device." },
                        "text": { "type": "STRING", "description": "Text to type into the active input field." }
                    },
                    "required": ["deviceId", "text"]
                }
            },
            {
                "name": "device_swipe",
                "description": "Performs a swipe or drag gesture on the target device from a starting coordinate to an ending coordinate using a natural movement curve.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "deviceId": { "type": "STRING", "description": "The unique ID of the target device." },
                        "fromX": { "type": "INTEGER", "description": "Starting X coordinate." },
                        "fromY": { "type": "INTEGER", "description": "Starting Y coordinate." },
                        "toX": { "type": "INTEGER", "description": "Ending X coordinate." },
                        "toY": { "type": "INTEGER", "description": "Ending Y coordinate." },
                        "duration": { "type": "INTEGER", "description": "Duration of the swipe event in milliseconds (default 300)." }
                    },
                    "required": ["deviceId", "fromX", "fromY", "toX", "toY"]
                }
            },
            {
                "name": "device_navigate",
                "description": "Directs the target device to navigate to the specified URL.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "deviceId": { "type": "STRING", "description": "The unique ID of the target device." },
                        "url": { "type": "STRING", "description": "The URL to open/navigate to." }
                    },
                    "required": ["deviceId", "url"]
                }
            },
            {
                "name": "device_scroll",
                "description": "Emulates scrolling on the target device starting at a specific coordinate position.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "deviceId": { "type": "STRING", "description": "The unique ID of the target device." },
                        "x": { "type": "INTEGER", "description": "The X coordinate where the scroll starts (hover position)." },
                        "y": { "type": "INTEGER", "description": "The Y coordinate where the scroll starts (hover position)." },
                        "deltaX": { "type": "INTEGER", "description": "Horizontal scroll distance (positive: right, negative: left)." },
                        "deltaY": { "type": "INTEGER", "description": "Vertical scroll distance (positive: down, negative: up)." }
                    },
                    "required": ["deviceId", "x", "y", "deltaX", "deltaY"]
                }
            }
        ]
    }
]

def inject_tools():
    dataset_dir = "datasets"
    file_pattern = os.path.join(dataset_dir, "messages*.jsonl")
    
    for filepath in glob.glob(file_pattern):
        processed_lines = []
        
        with open(filepath, 'r', encoding='utf-8') as f:
            for line in f:
                if not line.strip():
                    continue
                    
                data = json.loads(line)
                
                # Append tools definition to the object
                data["tools"] = TOOLS_DEF
                processed_lines.append(data)
                
        # Overwrite the file with the updated data
        with open(filepath, 'w', encoding='utf-8') as f:
            for d in processed_lines:
                f.write(json.dumps(d) + '\n')
                
        print(f"Injected tools into: {filepath}")

if __name__ == "__main__":
    inject_tools()
