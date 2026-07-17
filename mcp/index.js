import express from "express";
import fs from "fs/promises";
import path from "path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// 1. Initialize the MCP Server
const mcpServer = new Server(
  { 
    name: "local-file-modifier", 
    version: "1.0.0" 
  },
  { 
    capabilities: { 
      tools: {} 
    } 
  }
);

// Helper function to recursively search directories for file content
async function* getFiles(dir) {
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  for (const dirent of dirents) {
    const res = path.resolve(dir, dirent.name);
    if (dirent.isDirectory()) {
      // Skip common heavy directories to keep it fast
      if (dirent.name === "node_modules" || dirent.name === ".git" || dirent.name === "dist") continue;
      yield* getFiles(res);
    } else {
      yield res;
    }
  }
}

// 2. Define Advanced Filesystem Tools
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_dir",
        description: "List contents of a directory with file types (files and subdirectories).",
        inputSchema: {
          type: "object",
          properties: {
            dirPath: { type: "string", description: "Absolute path to the directory." }
          },
          required: ["dirPath"]
        }
      },
      {
        name: "search",
        description: "Search for files by name or scan inside file contents for specific text/query strings across a workspace directory tree.",
        inputSchema: {
          type: "object",
          properties: {
            baseDir: { type: "string", description: "Absolute path to the directory tree root to start searching from." },
            query: { type: "string", description: "The text string or regex pattern to search for." },
            searchInsideContent: { type: "boolean", description: "If true, scans inside the text contents of the files. If false, only checks filenames.", default: false }
          },
          required: ["baseDir", "query"]
        }
      },
      {
        name: "read_file_lines",
        description: "Read a specific range of lines from a local file (useful for large files to optimize context window space).",
        inputSchema: {
          type: "object",
          properties: {
            filePath: { type: "string", description: "Absolute path to the file." },
            startLine: { type: "number", description: "The 1-indexed line number to start reading from.", default: 1 },
            endLine: { type: "number", description: "The 1-indexed line number to stop reading at." }
          },
          required: ["filePath", "endLine"]
        }
      },
      {
        name: "write_file",
        description: "Write or overwrite contents to a local file.",
        inputSchema: {
          type: "object",
          properties: {
            filePath: { type: "string", description: "Absolute path to the destination file." },
            content: { type: "string", description: "The content to write into the file." }
          },
          required: ["filePath", "content"]
        }
      }
    ]
  };
});

// 3. Handle Tool Execution
mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    // ---- TOOL: list_dir ----
    if (name === "list_dir") {
      const resolvedPath = path.resolve(args.dirPath);
      const files = await fs.readdir(resolvedPath, { withFileTypes: true });
      const output = files.map(f => `[${f.isDirectory() ? 'DIR' : 'FILE'}] ${f.name}`).join("\n");
      return { content: [{ type: "text", text: output || "(Directory is empty)" }] };
    }

    // ---- TOOL: search ----
    if (name === "search") {
      const resolvedBase = path.resolve(args.baseDir);
      const results = [];
      const searchRegex = new RegExp(args.query, "i");

      for await (const file of getFiles(resolvedBase)) {
        const relativePath = path.relative(resolvedBase, file);
        
        // Match filename
        if (searchRegex.test(path.basename(file))) {
          results.push(`[Match: Filename] ${relativePath}`);
          continue; 
        }

        // Match content if requested
        if (args.searchInsideContent) {
          try {
            const content = await fs.readFile(file, "utf-8");
            if (searchRegex.test(content)) {
              // Find matching lines for helpful context snippet
              const lines = content.split("\n");
              lines.forEach((line, index) => {
                if (searchRegex.test(line)) {
                  results.push(`[Match: Content] ${relativePath} (Line ${index + 1}): ${line.trim()}`);
                }
              });
            }
          } catch (e) {
            // Skip unreadable files or binaries cleanly
            continue;
          }
        }
      }
      return { content: [{ type: "text", text: results.join("\n") || "No matches found." }] };
    }

    // ---- TOOL: read_file_lines ----
    if (name === "read_file_lines") {
      const resolvedPath = path.resolve(args.filePath);
      const start = args.startLine ?? 1;
      const end = args.endLine;

      const data = await fs.readFile(resolvedPath, "utf-8");
      const lines = data.split("\n");
      
      // Slice lines based on 1-based indexing
      const slicedLines = lines.slice(start - 1, end);
      const output = slicedLines.map((line, idx) => `${start + idx}: ${line}`).join("\n");
      
      return { content: [{ type: "text", text: output }] };
    }

    // ---- TOOL: write_file ----
    if (name === "write_file") {
      const resolvedPath = path.resolve(args.filePath);
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
      await fs.writeFile(resolvedPath, args.content, "utf-8");
      return { content: [{ type: "text", text: `Successfully wrote to ${resolvedPath}` }] };
    }

    throw new Error(`Tool not found: ${name}`);
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error executing ${name}: ${error.message}` }]
    };
  }
});

// 4. Set up Express Server with Session Mapping
const activeTransports = new Map();
const app = express();

app.use((req, res, next) => {
  const requestOrigin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", requestOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-protocol-version, authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

app.get("/sse", async (req, res) => {
  console.log("Llama.cpp Web UI initializing SSE connection stream...");
  const transport = new SSEServerTransport("/messages", res);
  const sessionId = transport.sessionId;
  activeTransports.set(sessionId, transport);
  console.log(`Active session registered: ${sessionId}`);
  
  res.on("close", () => {
    console.log(`Session closed and removed: ${sessionId}`);
    activeTransports.delete(sessionId);
  });

  await mcpServer.connect(transport);
});

app.post("/messages", express.json(), async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = activeTransports.get(sessionId);

  if (transport) {
    const requestOrigin = req.headers.origin || "*";
    res.setHeader("Access-Control-Allow-Origin", requestOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-protocol-version, authorization");
    res.setHeader("Access-Control-Allow-Credentials", "true");

    const originalWriteHead = res.writeHead;
    res.writeHead = function (statusCode, headers) {
      res.setHeader("Access-Control-Allow-Origin", requestOrigin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      return originalWriteHead.call(this, statusCode, headers);
    };

    await transport.handleMessage(req.body, res);

    if (!res.writableEnded) {
      res.status(202).end();
    }
  } else {
    console.error(`Session not found for ID: ${sessionId}`);
    res.status(404).send("Session not found");
  }
});

const PORT = 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\nMCP Filesystem Server listening!`);
  console.log(`SSE Connect URL: http://localhost:${PORT}/sse`);
});