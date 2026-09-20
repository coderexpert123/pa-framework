#!/usr/bin/env node
/**
 * pa MCP server — stdio transport
 *
 * Read-only tools wrapping existing pa exports:
 * - pa_ref_lookup: Look up a ref-ID
 * - pa_claims: List active reservations + recent modifications
 * - pa_maintenance_status: Show maintenance ledger
 * - pa_costs: Usage/cost rollup
 * - pa_slo_report: SLO error budget report
 * - pa_recall: Full-text search over turns, traces, brains, KB
 *
 * Usage: pa mcp serve
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { tools, pa_ref_lookup, pa_claims, pa_maintenance_status, pa_costs, pa_slo_report, pa_recall, bus_send, bus_inbox, bus_wait, bus_list, bus_whoami } from './tools.js';

/**
 * Create and start the MCP server.
 */
async function main() {
  const server = new Server(
    {
      name: 'pa-cli-mcp-server',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register tool handlers
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = request.params.arguments ?? {};

    try {
      let result;
      switch (toolName) {
        case 'pa_ref_lookup':
          result = await pa_ref_lookup.handler(args);
          break;
        case 'pa_claims':
          result = await pa_claims.handler(args);
          break;
        case 'pa_maintenance_status':
          result = await pa_maintenance_status.handler(args);
          break;
        case 'pa_costs':
          result = await pa_costs.handler(args);
          break;
        case 'pa_slo_report':
          result = await pa_slo_report.handler(args);
          break;
        case 'pa_recall':
          result = await pa_recall.handler(args);
          break;
        case 'bus_send':
          result = await bus_send.handler(args);
          break;
        case 'bus_inbox':
          result = await bus_inbox.handler(args);
          break;
        case 'bus_wait':
          result = await bus_wait.handler(args);
          break;
        case 'bus_list':
          result = await bus_list.handler(args);
          break;
        case 'bus_whoami':
          result = await bus_whoami.handler(args);
          break;
        default:
          throw new Error(`Unknown tool: ${toolName}`);
      }

      return {
        content: [
          {
            type: 'text',
            text: result,
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  });

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    };
  });

  // Start the server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Server is now listening on stdin/stdout
  // Process stays alive until the stdin stream closes
}

main().catch((error) => {
  console.error('Fatal error starting MCP server:', error);
  process.exit(1);
});
