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
    {
      name: 'sum_numbers',
      description: 'Returns the sum of finite input numbers.',
      inputSchema: {
        type: 'object',
        properties: { values: { type: 'array', items: { type: 'number' } } },
        required: ['values'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, (request) =>
  request.params.name === 'sum_numbers'
    ? {
        content: [
          {
            type: 'text',
            text: String(
              (request.params.arguments?.values as readonly number[]).reduce(
                (total, value) => total + value,
                0,
              ),
            ),
          },
        ],
      }
    : { content: [{ type: 'text', text: String(request.params.arguments?.message ?? '') }] },
);

await server.connect(new StdioServerTransport());
