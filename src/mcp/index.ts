import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer, type McpOptions } from './server.js';

/** Run the MCP server on stdio. stdout carries protocol messages only; diagnostics go to stderr. */
export async function runMcpStdio(opts: McpOptions = {}): Promise<void> {
  const { server, store } = createMcpServer(opts);
  process.on('uncaughtException', (e) => process.stderr.write(`crawlscope mcp: uncaught ${e.stack ?? e}\n`));
  process.on('unhandledRejection', (e) => process.stderr.write(`crawlscope mcp: unhandled rejection ${String(e)}\n`));
  await server.connect(new StdioServerTransport());
  process.stderr.write(`crawlscope MCP server ready (data dir: ${store.dataDir})\n`);
}
