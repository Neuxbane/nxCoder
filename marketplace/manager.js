import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { GeminiProvider } from "./builtin/providers/gemini.js";
import { OllamaProvider } from "./builtin/providers/ollama.js";
import { OpenAIProvider } from "./builtin/providers/openai.js";
import { createBuiltinMcpServer } from "./builtin/mcp/filesystem.js";

// BridgeTransport for connecting built-in client and server in-memory
class BridgeTransport {
  constructor() {
    this.onclose = null;
    this.onerror = null;
    this.onmessage = null;
    this.peer = null;
  }
  async start() {}
  async close() {
    if (this.onclose) this.onclose();
    if (this.peer && this.peer.onclose) {
      this.peer.onclose();
      this.peer.onclose = null;
    }
    this.onclose = null;
  }
  async send(message) {
    setImmediate(() => {
      if (this.peer && this.peer.onmessage) {
        this.peer.onmessage(message);
      }
    });
  }
}

function createBridgeTransports() {
  const clientTx = new BridgeTransport();
  const serverTx = new BridgeTransport();
  clientTx.peer = serverTx;
  serverTx.peer = clientTx;
  return { clientTx, serverTx };
}

export class MarketplaceManager {
  constructor(db) {
    this.db = db;
    this.providers = new Map(); // id -> providerClass
    this.activeMcpClients = new Map(); // mcpId -> Client instance
    this.mcpServersList = []; // Array of registered MCP server rows
    
    // Register built-in providers
    this.registerProvider(GeminiProvider);
    this.registerProvider(OllamaProvider);
    this.registerProvider(OpenAIProvider);
  }

  registerProvider(providerClass) {
    this.providers.set(providerClass.id, providerClass);
    console.log(`[Marketplace] Registered provider: ${providerClass.name} (${providerClass.id})`);
  }

  async initDatabase() {
    // 1. marketplace_sources
    await this.dbRun(`CREATE TABLE IF NOT EXISTS marketplace_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT,
      source TEXT UNIQUE,
      added_at TEXT
    )`);

    // 2. provider_configs
    await this.dbRun(`CREATE TABLE IF NOT EXISTS provider_configs (
      id TEXT PRIMARY KEY,
      name TEXT,
      provider_id TEXT,
      config TEXT,
      active INTEGER DEFAULT 0,
      created_at TEXT
    )`);

    // 3. mcp_servers
    await this.dbRun(`CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT,
      type TEXT,
      source TEXT UNIQUE,
      active INTEGER DEFAULT 1,
      created_at TEXT
    )`);
  }

  // Helper functions for database access
  dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function(err) {
        if (err) reject(err);
        else resolve(this);
      });
    });
  }

  dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  // Sync / Load marketplace
  async syncMarketplace() {
    // Load local sources.json
    const sourcesPath = path.resolve('marketplace/sources.json');
    try {
      const data = await fs.readFile(sourcesPath, 'utf-8');
      const sources = JSON.parse(data);
      for (const src of sources) {
        await this.addSource(src.type, src.source);
      }
    } catch (err) {
      console.warn('[Marketplace] No sources.json found or failed to parse, skipping initial import.', err.message);
    }
  }

  async addSource(type, source) {
    // Check if source already in database
    const existing = await this.dbGet("SELECT id FROM marketplace_sources WHERE source = ?", [source]);
    if (existing) {
      return { skipped: true, source };
    }

    await this.dbRun(
      "INSERT INTO marketplace_sources (type, source, added_at) VALUES (?, ?, ?)",
      [type, source, new Date().toISOString()]
    );

    if (type === 'marketplace') {
      // Fetch nested marketplace.json and register its sources
      try {
        const response = await fetch(source);
        if (response.ok) {
          const nestedSources = await response.json();
          for (const nest of nestedSources) {
            await this.addSource(nest.type, nest.source);
          }
        }
      } catch (err) {
        console.error(`[Marketplace] Failed to sync marketplace source: ${source}`, err.message);
      }
    } else if (type === 'mcp') {
      // Add standard MCP server
      const id = 'mcp_' + crypto.randomUUID().substring(0, 8);
      let name = source;
      if (source.startsWith('builtin://')) {
        name = 'Builtin Filesystem & Device Tools';
      }
      await this.dbRun(
        "INSERT OR IGNORE INTO mcp_servers (id, name, type, source, active, created_at) VALUES (?, ?, ?, ?, 1, ?)",
        [id, name, source.startsWith('builtin://') ? 'builtin' : 'sse', source, new Date().toISOString()]
      );
    }

    return { added: true, type, source };
  }

  async getSources() {
    return await this.dbAll("SELECT * FROM marketplace_sources");
  }

  async removeSource(id) {
    const src = await this.dbGet("SELECT source FROM marketplace_sources WHERE id = ?", [id]);
    if (src) {
      await this.dbRun("DELETE FROM marketplace_sources WHERE id = ?", [id]);
      await this.dbRun("DELETE FROM mcp_servers WHERE source = ?", [src.source]);
      return { success: true };
    }
    return { error: 'Source not found' };
  }

  // Providers List & Schemas
  getProvidersList() {
    const list = [];
    for (const [id, providerClass] of this.providers.entries()) {
      list.push({
        id,
        name: providerClass.name,
        schema: providerClass.configSchema
      });
    }
    return list;
  }

  async isProviderInstalled(providerId) {
    if (providerId === 'gemini' || providerId === 'ollama' || providerId === 'openai') {
      return true;
    }
    const dirPath = path.resolve('marketplace/downloaded/provider', providerId);
    const filePath = path.resolve('marketplace/downloaded/provider', `${providerId}.js`);
    try {
      await fs.access(dirPath);
      return true;
    } catch {
      try {
        await fs.access(filePath);
        return true;
      } catch {
        return false;
      }
    }
  }

  async isMcpInstalled(mcp) {
    if (mcp.type === 'builtin') {
      return true;
    }
    if (mcp.type === 'sse') {
      return true;
    }
    const dirPath = path.resolve('marketplace/downloaded/mcp', mcp.id);
    const filePath = path.resolve('marketplace/downloaded/mcp', `${mcp.id}.js`);
    try {
      await fs.access(dirPath);
      return true;
    } catch {
      try {
        await fs.access(filePath);
        return true;
      } catch {
        return false;
      }
    }
  }

  // Active / Saved configurations
  async getProviderConfigs() {
    const rows = await this.dbAll("SELECT * FROM provider_configs");
    return rows.map(r => ({
      ...r,
      config: JSON.parse(r.config)
    }));
  }

  async addProviderConfig(name, providerId, config) {
    const id = 'cfg_' + crypto.randomUUID().substring(0, 8);
    // If it's the first config, make it active
    const countRow = await this.dbGet("SELECT COUNT(*) as count FROM provider_configs");
    const active = countRow.count === 0 ? 1 : 0;

    await this.dbRun(
      "INSERT INTO provider_configs (id, name, provider_id, config, active, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [id, name, providerId, JSON.stringify(config), active, new Date().toISOString()]
    );
    return { id, name, providerId, active };
  }

  async updateProviderConfig(id, name, config) {
    await this.dbRun(
      "UPDATE provider_configs SET name = ?, config = ? WHERE id = ?",
      [name, JSON.stringify(config), id]
    );
    return { success: true };
  }

  async deleteProviderConfig(id) {
    await this.dbRun("DELETE FROM provider_configs WHERE id = ?", [id]);
    return { success: true };
  }

  async setActiveProviderConfig(id) {
    await this.dbRun("UPDATE provider_configs SET active = 0");
    await this.dbRun("UPDATE provider_configs SET active = 1 WHERE id = ?", [id]);
    return { success: true };
  }

  async getActiveProvider() {
    const keys = await this.dbAll("SELECT * FROM api_keys WHERE active = 1");
    if (!keys || keys.length === 0) {
      const geminiKey = process.env.GEMINI_API_KEY;
      if (geminiKey) {
        const providerClass = this.providers.get('gemini');
        if (providerClass) {
          return new providerClass({ apiKey: geminiKey, defaultModel: 'gemini-2.5-flash' });
        }
      }
      return null;
    }

    // Select provider based on first active key, and filter active keys for that provider
    const activeProviderId = keys[0].provider_id || 'gemini';
    const providerKeys = keys.filter(k => (k.provider_id || 'gemini') === activeProviderId);

    if (!this.rotationIndex) this.rotationIndex = 0;
    const selectedKey = providerKeys[this.rotationIndex % providerKeys.length];
    this.rotationIndex++;

    const providerClass = this.providers.get(activeProviderId);
    if (!providerClass) return null;

    let parsedConfig = {};
    try {
      parsedConfig = JSON.parse(selectedKey.key);
    } catch (e) {
      if (activeProviderId === 'gemini') {
        parsedConfig = { apiKey: selectedKey.key, defaultModel: 'gemini-2.5-flash' };
      }
    }

    return new providerClass(parsedConfig);
  }

  // MCP Management
  async getMcpServers() {
    return await this.dbAll("SELECT * FROM mcp_servers");
  }

  async toggleMcpServer(id, active) {
    await this.dbRun("UPDATE mcp_servers SET active = ? WHERE id = ?", [active ? 1 : 0, id]);
    return { success: true };
  }

  async addMcpServerDirect(name, type, source) {
    const id = 'mcp_' + crypto.randomUUID().substring(0, 8);
    await this.dbRun(
      "INSERT INTO mcp_servers (id, name, type, source, active, created_at) VALUES (?, ?, ?, ?, 1, ?)",
      [id, name, type, source, new Date().toISOString()]
    );
    return { id, name, type, source };
  }

  async deleteMcpServerDirect(id) {
    await this.dbRun("DELETE FROM mcp_servers WHERE id = ?", [id]);
    return { success: true };
  }

  // Initialize and get all active MCP tools and clients
  async connectMcpClients(deps) {
    // Close existing clients first
    await this.closeAllMcpClients();

    const activeServers = await this.dbAll("SELECT * FROM mcp_servers WHERE active = 1");
    const allTools = [];
    const toolToClient = new Map(); // toolName -> clientInstance

    for (const serverRow of activeServers) {
      try {
        console.log(`[Marketplace] Connecting to MCP Server: ${serverRow.name} (${serverRow.type})`);
        
        let client;
        let transport;

        if (serverRow.type === 'builtin') {
          // Initialize builtin tools MCP server
          const mcpServer = createBuiltinMcpServer(deps);
          const { clientTx, serverTx } = createBridgeTransports();
          
          client = new Client(
            { name: "nxCoder-client-builtin", version: "1.0.0" },
            { capabilities: { tools: {} } }
          );

          await mcpServer.connect(serverTx);
          await client.connect(clientTx);
        } else if (serverRow.type === 'sse') {
          // Initialize remote SSE MCP server
          client = new Client(
            { name: "nxCoder-client-sse", version: "1.0.0" },
            { capabilities: { tools: {} } }
          );
          transport = new SSEClientTransport(new URL(serverRow.source));
          await client.connect(transport);
        } else {
          console.warn(`[Marketplace] Unsupported MCP server type: ${serverRow.type}`);
          continue;
        }

        // List tools and save client mapping
        const response = await client.listTools();
        const serverTools = response.tools || [];
        
        for (const tool of serverTools) {
          allTools.push(tool);
          toolToClient.set(tool.name, client);
        }

        this.activeMcpClients.set(serverRow.id, { client, transport });
        console.log(`[Marketplace] Successfully connected to ${serverRow.name}, loaded ${serverTools.length} tools.`);
      } catch (err) {
        console.error(`[Marketplace] Failed to connect to MCP server ${serverRow.name}:`, err.message);
      }
    }

    this.toolToClient = toolToClient;
    return allTools;
  }

  async executeMcpTool(toolName, args) {
    if (!this.toolToClient || !this.toolToClient.has(toolName)) {
      throw new Error(`Tool execution target "${toolName}" is not registered on any active MCP server.`);
    }

    const client = this.toolToClient.get(toolName);
    const result = await client.callTool({
      name: toolName,
      arguments: args
    });
    
    // MCP client callTool returns { content: [ { type: "text", text: "..." } ] }
    // We parse and extract the text or return it in standard form
    if (result.isError) {
      const errText = result.content?.map(c => c.text).join('\n') || 'Unknown tool error';
      throw new Error(errText);
    }

    if (result.content && result.content.length > 0) {
      const firstTextPart = result.content.find(c => c.type === 'text');
      if (firstTextPart) {
        try {
          // If the output text is JSON, parse and return it
          return JSON.parse(firstTextPart.text);
        } catch (e) {
          return { success: true, output: firstTextPart.text };
        }
      }
    }

    return result;
  }

  async closeAllMcpClients() {
    for (const [id, mcpObj] of this.activeMcpClients.entries()) {
      try {
        await mcpObj.client.close();
        if (mcpObj.transport) {
          await mcpObj.transport.close();
        }
      } catch (e) {
        // Ignore close errors
      }
    }
    this.activeMcpClients.clear();
    if (this.toolToClient) this.toolToClient.clear();
    console.log('[Marketplace] Closed all active MCP client connections.');
  }
}
