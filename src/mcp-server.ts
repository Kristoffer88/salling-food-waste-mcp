import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { tools } from "./core.js";

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "salling-food-waste",
    version: "1.0.0",
  });
  for (const [name, { config, handler }] of Object.entries(tools)) {
    server.registerTool(name, config, handler);
  }
  return server;
}

// --- HTTP mode: Streamable HTTP on PORT ---

async function runHttp() {
  const port = parseInt(process.env.PORT ?? "3001", 10);
  const server = createMcpServer();

  const httpServer = createServer(async (req, res) => {
    if (req.url === "/mcp" && req.method === "POST") {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }
    // Health check
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  });

  httpServer.listen(port, () => {
    console.error(`MCP HTTP server listening on http://localhost:${port}/mcp`);
  });
}

// --- Stdio mode: standard MCP JSON-RPC over stdin/stdout ---

async function runStdio() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// --- Entrypoint ---

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === "--http") {
    await runHttp();
  } else {
    await runStdio();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
