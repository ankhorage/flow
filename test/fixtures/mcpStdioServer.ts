import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'flow-test-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: 'safe_echo',
      description: 'Returns input without side effects.',
      inputSchema: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'not_allowlisted',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, (request) => ({
  content: [{ type: 'text', text: String(request.params.arguments?.message ?? '') }],
}));

await server.connect(new StdioServerTransport());
