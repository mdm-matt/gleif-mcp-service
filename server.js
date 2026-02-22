#!/usr/bin/env node

import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';

const PORT = process.env.PORT || 8080;
const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

// Session store for Streamable HTTP transport
const sessions = new Map();

// GLEIF API base URL (public, no auth required)
const GLEIF_BASE = 'https://api.gleif.org/api/v1';

// Server instructions for LLMs using this MCP server
const SERVER_INSTRUCTIONS = `# GLEIF LEI Lookup Service

## Overview
This MCP server provides tools for searching and exploring the Global Legal Entity Identifier (LEI) system via the GLEIF public API. LEI is a 20-character alphanumeric code that uniquely identifies legal entities participating in financial transactions worldwide.

## Available Tools (9)

| Tool | Function |
|------|----------|
| search_lei | Search LEI records by entity legal name |
| get_lei | Get a specific LEI record by its 20-character LEI code |
| fuzzy_search | Fuzzy name matching for entities (handles typos and partial names) |
| autocomplete | Fast autocomplete suggestions for entity names |
| search_by_bic | Search LEI records by BIC (Bank Identifier Code / SWIFT code) |
| search_by_isin | Search LEI records by ISIN (International Securities Identification Number) |
| get_direct_parent | Get the direct parent entity of a given LEI |
| get_ultimate_parent | Get the ultimate parent entity of a given LEI |
| get_direct_children | Get all direct subsidiaries/children of a given LEI |

## Key Concepts
- **LEI**: Legal Entity Identifier — a 20-character code (e.g., "INR2EJN1ERAN0W5ZP974" for Microsoft)
- **BIC/SWIFT**: Bank Identifier Code used in international banking
- **ISIN**: International Securities Identification Number for stocks/bonds
- **LOU**: Local Operating Unit — the organization that issued the LEI
- **Registration Status**: ISSUED (active), LAPSED, RETIRED, CANCELLED, etc.

## Recommended Workflows

### Entity Lookup
1. \`search_lei\` or \`fuzzy_search\` — find an entity by name
2. \`get_lei\` — get full details for a specific LEI
3. \`get_direct_parent\` / \`get_ultimate_parent\` — explore corporate hierarchy upward
4. \`get_direct_children\` — explore subsidiaries downward

### Financial Identifier Cross-Reference
1. \`search_by_bic\` — find the legal entity behind a SWIFT/BIC code
2. \`search_by_isin\` — find the legal entity behind a securities identifier

### Name Discovery
1. \`autocomplete\` — fast prefix-based suggestions (best for UI typeahead)
2. \`fuzzy_search\` — tolerant matching (best for typos and partial names)

## Tips
- Use \`fuzzy_search\` when unsure of exact spelling
- Use \`autocomplete\` for fast prefix matching
- Parent/child lookups may return a "reporting exception" if the entity has not reported its corporate structure
- All data is from the official GLEIF database, updated daily`;

const app = express();
app.use(cors());
app.use(express.json());

// ============================================================
// GLEIF API Helper
// ============================================================

async function gleifGet(path, params = {}) {
  const url = new URL(`${GLEIF_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url.toString(), {
    headers: { 'Accept': 'application/vnd.api+json' },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GLEIF API returned ${response.status}: ${errorText.substring(0, 500)}`);
  }

  return response.json();
}

// ============================================================
// Response Transformers — flatten JSON:API into clean objects
// ============================================================

function transformAddress(addr) {
  if (!addr) return null;
  return {
    addressLines: addr.addressLines || [],
    city: addr.city || '',
    region: addr.region || '',
    country: addr.country || '',
    postalCode: addr.postalCode || '',
  };
}

function transformLeiRecord(record) {
  if (!record) return null;
  const attrs = record.attributes || {};
  const entity = attrs.entity || {};
  const reg = attrs.registration || {};
  const bic = attrs.bic || [];

  return {
    lei: attrs.lei || record.id,
    legalName: entity.legalName?.name || '',
    otherNames: (entity.otherNames || []).map(n => ({ name: n.name, type: n.type })),
    status: entity.status || '',
    jurisdiction: entity.jurisdiction || '',
    category: entity.category || '',
    legalForm: entity.legalForm?.id || '',
    legalFormOther: entity.legalForm?.other || '',
    registeredAs: entity.registeredAs || '',
    legalAddress: transformAddress(entity.legalAddress),
    headquartersAddress: transformAddress(entity.headquartersAddress),
    registrationStatus: reg.status || '',
    initialRegistrationDate: reg.initialRegistrationDate || '',
    lastUpdateDate: reg.lastUpdateDate || '',
    nextRenewalDate: reg.nextRenewalDate || '',
    managingLou: reg.managingLou || '',
    corroborationLevel: reg.corroborationLevel || '',
    bic: bic,
    conformityFlag: attrs.conformityFlag || '',
  };
}

function transformRelationship(record) {
  if (!record) return null;
  const attrs = record.attributes || {};
  const rel = attrs.relationship || {};
  const reg = attrs.registration || {};

  return {
    type: record.type || '',
    startNode: rel.startNode || {},
    endNode: rel.endNode || {},
    relationshipType: rel.type || '',
    status: rel.status || '',
    registrationStatus: reg.status || '',
    initialRegistrationDate: reg.initialRegistrationDate || '',
    lastUpdateDate: reg.lastUpdateDate || '',
    managingLou: reg.managingLou || '',
  };
}

// ============================================================
// Tool Definitions
// ============================================================

const TOOLS = [
  {
    name: 'search_lei',
    description: 'Search LEI records by entity legal name. Returns matching entities with their LEI codes, addresses, registration status, and other details.',
    inputSchema: {
      type: 'object',
      properties: {
        legalName: { type: 'string', description: 'The legal name of the entity to search for (e.g., "Microsoft Corporation")' },
        page_size: { type: 'number', description: 'Number of results to return (default 10, max 100)' },
      },
      required: ['legalName'],
    },
  },
  {
    name: 'get_lei',
    description: 'Get a specific LEI record by its 20-character LEI code. Returns full entity details including legal name, addresses, registration info, and BIC codes.',
    inputSchema: {
      type: 'object',
      properties: {
        lei: { type: 'string', description: 'The 20-character LEI code (e.g., "INR2EJN1ERAN0W5ZP974")' },
      },
      required: ['lei'],
    },
  },
  {
    name: 'fuzzy_search',
    description: 'Fuzzy name matching for legal entities. Tolerant of typos and partial names. Returns entity names with their LEI codes.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The entity name to fuzzy match (e.g., "Microsft" will match "Microsoft")' },
      },
      required: ['query'],
    },
  },
  {
    name: 'autocomplete',
    description: 'Fast autocomplete for entity names. Best for prefix-based matching and typeahead scenarios. Returns suggestions with LEI codes.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The prefix or partial name to autocomplete (e.g., "Micro")' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_by_bic',
    description: 'Search LEI records by BIC (Bank Identifier Code / SWIFT code). Use this to find the legal entity behind a banking identifier.',
    inputSchema: {
      type: 'object',
      properties: {
        bic: { type: 'string', description: 'The BIC/SWIFT code to search for (e.g., "CHASUS33XXX" for JPMorgan Chase)' },
        page_size: { type: 'number', description: 'Number of results to return (default 10, max 100)' },
      },
      required: ['bic'],
    },
  },
  {
    name: 'search_by_isin',
    description: 'Search LEI records by ISIN (International Securities Identification Number). Use this to find the legal entity behind a securities identifier.',
    inputSchema: {
      type: 'object',
      properties: {
        isin: { type: 'string', description: 'The ISIN code to search for (e.g., "US5949181045" for Microsoft stock)' },
        page_size: { type: 'number', description: 'Number of results to return (default 10, max 100)' },
      },
      required: ['isin'],
    },
  },
  {
    name: 'get_direct_parent',
    description: 'Get the direct parent entity of a given LEI. Returns the immediate parent company or a reporting exception if not reported.',
    inputSchema: {
      type: 'object',
      properties: {
        lei: { type: 'string', description: 'The 20-character LEI code of the entity whose parent to find' },
      },
      required: ['lei'],
    },
  },
  {
    name: 'get_ultimate_parent',
    description: 'Get the ultimate parent entity of a given LEI. Returns the top-level parent in the corporate hierarchy or a reporting exception.',
    inputSchema: {
      type: 'object',
      properties: {
        lei: { type: 'string', description: 'The 20-character LEI code of the entity whose ultimate parent to find' },
      },
      required: ['lei'],
    },
  },
  {
    name: 'get_direct_children',
    description: 'Get all direct subsidiaries/children of a given LEI. Returns a list of entities that report this LEI as their direct parent.',
    inputSchema: {
      type: 'object',
      properties: {
        lei: { type: 'string', description: 'The 20-character LEI code of the parent entity' },
        page_size: { type: 'number', description: 'Number of results to return (default 20, max 100)' },
      },
      required: ['lei'],
    },
  },
];

// ============================================================
// Tool Handlers
// ============================================================

const TOOL_HANDLERS = {
  search_lei: async (args) => {
    const pageSize = Math.min(Math.max(args.page_size || 10, 1), 100);
    const data = await gleifGet('/lei-records', {
      'filter[entity.legalName]': args.legalName,
      'page[size]': pageSize,
    });
    const records = (data.data || []).map(transformLeiRecord);
    return { count: records.length, total: data.meta?.pagination?.total || records.length, records };
  },

  get_lei: async (args) => {
    const data = await gleifGet(`/lei-records/${encodeURIComponent(args.lei)}`);
    return transformLeiRecord(data.data);
  },

  fuzzy_search: async (args) => {
    const data = await gleifGet('/fuzzycompletions', {
      field: 'entity.legalName',
      q: args.query,
    });
    const suggestions = (data.data || []).map(item => ({
      lei: item.relationships?.['lei-records']?.data?.id || '',
      name: item.attributes?.value || '',
    }));
    return { count: suggestions.length, suggestions };
  },

  autocomplete: async (args) => {
    const data = await gleifGet('/autocompletions', {
      field: 'fulltext',
      q: args.query,
    });
    const suggestions = (data.data || []).map(item => ({
      lei: item.relationships?.['lei-records']?.data?.id || '',
      name: item.attributes?.value || '',
    }));
    return { count: suggestions.length, suggestions };
  },

  search_by_bic: async (args) => {
    const pageSize = Math.min(Math.max(args.page_size || 10, 1), 100);
    const data = await gleifGet('/lei-records', {
      'filter[bic]': args.bic,
      'page[size]': pageSize,
    });
    const records = (data.data || []).map(transformLeiRecord);
    return { count: records.length, total: data.meta?.pagination?.total || records.length, records };
  },

  search_by_isin: async (args) => {
    const pageSize = Math.min(Math.max(args.page_size || 10, 1), 100);
    const data = await gleifGet('/lei-records', {
      'filter[isin]': args.isin,
      'page[size]': pageSize,
    });
    const records = (data.data || []).map(transformLeiRecord);
    return { count: records.length, total: data.meta?.pagination?.total || records.length, records };
  },

  get_direct_parent: async (args) => {
    try {
      const data = await gleifGet(`/lei-records/${encodeURIComponent(args.lei)}/direct-parent`);
      // If it's a single record (data.data is an object)
      if (data.data && !Array.isArray(data.data)) {
        return transformLeiRecord(data.data);
      }
      // If it's a relationship response
      if (data.data && Array.isArray(data.data) && data.data.length > 0) {
        const rel = data.data[0];
        if (rel.type === 'lei-records') {
          return transformLeiRecord(rel);
        }
        return transformRelationship(rel);
      }
      return { message: 'No direct parent reported for this entity', lei: args.lei };
    } catch (error) {
      if (error.message.includes('404')) {
        return { message: 'No direct parent reported for this entity (reporting exception or not available)', lei: args.lei };
      }
      throw error;
    }
  },

  get_ultimate_parent: async (args) => {
    try {
      const data = await gleifGet(`/lei-records/${encodeURIComponent(args.lei)}/ultimate-parent`);
      if (data.data && !Array.isArray(data.data)) {
        return transformLeiRecord(data.data);
      }
      if (data.data && Array.isArray(data.data) && data.data.length > 0) {
        const rel = data.data[0];
        if (rel.type === 'lei-records') {
          return transformLeiRecord(rel);
        }
        return transformRelationship(rel);
      }
      return { message: 'No ultimate parent reported for this entity', lei: args.lei };
    } catch (error) {
      if (error.message.includes('404')) {
        return { message: 'No ultimate parent reported for this entity (reporting exception or not available)', lei: args.lei };
      }
      throw error;
    }
  },

  get_direct_children: async (args) => {
    const pageSize = Math.min(Math.max(args.page_size || 20, 1), 100);
    try {
      const data = await gleifGet(`/lei-records/${encodeURIComponent(args.lei)}/direct-children`, {
        'page[size]': pageSize,
      });
      const records = (data.data || []).map(transformLeiRecord);
      return { count: records.length, total: data.meta?.pagination?.total || records.length, parentLei: args.lei, children: records };
    } catch (error) {
      if (error.message.includes('404')) {
        return { message: 'No direct children found for this entity', lei: args.lei, children: [] };
      }
      throw error;
    }
  },
};

// ============================================================
// Health Check
// ============================================================

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', server: 'gleif-mcp-service', tools: TOOLS.length });
});

// ============================================================
// REST API Endpoints
// ============================================================

app.get('/tools', (req, res) => {
  const toolList = TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }));
  res.json({ tools: toolList, count: toolList.length });
});

app.post('/tools/:toolName', async (req, res) => {
  const { toolName } = req.params;
  const handler = TOOL_HANDLERS[toolName];

  if (!handler) {
    return res.status(404).json({ error: `Unknown tool: ${toolName}`, available: TOOLS.map(t => t.name) });
  }

  try {
    const result = await handler(req.body);
    res.json(result);
  } catch (error) {
    console.error(`REST /tools/${toolName} error:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// OpenAPI Spec
// ============================================================

app.get('/openapi.json', (req, res) => {
  res.json(generateOpenAPISpec(req));
});
app.get('/openapi.yaml', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.json(generateOpenAPISpec(req));
});

function generateOpenAPISpec(req) {
  const host = req ? `${req.protocol}://${req.get('host')}` : 'https://gleif-mcp-service.run.app';

  const paths = {};
  for (const tool of TOOLS) {
    const schema = tool.inputSchema || { type: 'object', properties: {} };

    paths[`/tools/${tool.name}`] = {
      post: {
        operationId: tool.name,
        summary: tool.description.substring(0, 120),
        description: tool.description,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: schema.type || 'object',
                properties: schema.properties || {},
                required: schema.required || [],
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Successful response',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          '500': {
            description: 'Error',
            content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' } } } } },
          },
        },
      },
    };
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'GLEIF LEI Lookup Service',
      description: 'Legal Entity Identifier (LEI) lookup tools powered by the GLEIF public API. Search entities, explore corporate hierarchies, and cross-reference financial identifiers (BIC, ISIN).',
      version: '1.0.0',
    },
    servers: [{ url: host, description: 'GLEIF MCP Service' }],
    paths,
  };
}

// ============================================================
// MCP Streamable HTTP Transport (2025-06-18)
// ============================================================

function validateSession(req, res) {
  const sessionId = req.headers['mcp-session-id'];
  if (!sessionId) return true;
  if (!sessions.has(sessionId)) {
    res.status(404).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Session not found. Send a new initialize request.' } });
    return false;
  }
  sessions.get(sessionId).lastActivity = Date.now();
  return true;
}

function sendResponse(req, res, response) {
  const acceptsSSE = req.headers.accept?.includes('text/event-stream');
  if (acceptsSSE) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.write(`data: ${JSON.stringify(response)}\n\n`);
    res.end();
  } else {
    res.setHeader('Content-Type', 'application/json');
    res.json(response);
  }
}

app.post('/mcp', async (req, res) => {
  const { jsonrpc, id, method, params } = req.body;

  if (jsonrpc !== '2.0') {
    return res.status(400).json({ jsonrpc: '2.0', id: id || null, error: { code: -32600, message: 'Invalid JSON-RPC version' } });
  }

  // Handle initialize (no session required)
  if (method === 'initialize') {
    const clientVersion = params?.protocolVersion || '2024-11-05';
    const negotiatedVersion = SUPPORTED_VERSIONS.includes(clientVersion) ? clientVersion : PROTOCOL_VERSION;

    const sessionId = randomUUID();
    sessions.set(sessionId, {
      id: sessionId,
      created: Date.now(),
      lastActivity: Date.now(),
      negotiatedVersion,
    });

    const result = {
      protocolVersion: negotiatedVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'gleif-mcp-service', version: '1.0.0' },
      instructions: SERVER_INSTRUCTIONS,
    };

    res.setHeader('Mcp-Session-Id', sessionId);
    return sendResponse(req, res, { jsonrpc: '2.0', id, result });
  }

  // Validate session for all other methods
  if (!validateSession(req, res)) return;

  // Validate MCP-Protocol-Version header if present
  const protocolHeader = req.headers['mcp-protocol-version'];
  if (protocolHeader && !SUPPORTED_VERSIONS.includes(protocolHeader)) {
    return res.status(400).json({ jsonrpc: '2.0', id: id || null, error: { code: -32600, message: `Unsupported protocol version: ${protocolHeader}`, data: { supported: SUPPORTED_VERSIONS } } });
  }

  // Handle notifications (no id, return 202)
  if (!id && method) {
    return res.status(202).end();
  }

  // Handle JSON-RPC responses from client (no method, return 202)
  if (!method && id) {
    return res.status(202).end();
  }

  try {
    let result;

    switch (method) {
      case 'ping':
        result = {};
        break;

      case 'tools/list':
        result = { tools: TOOLS };
        break;

      case 'tools/call': {
        const { name, arguments: args } = params;
        const handler = TOOL_HANDLERS[name];

        if (!handler) {
          return sendResponse(req, res, { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } });
        }

        try {
          const data = await handler(args);
          result = {
            content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
          };
        } catch (error) {
          result = {
            content: [{ type: 'text', text: `Error: ${error.message}` }],
            isError: true,
          };
        }
        break;
      }

      default:
        return sendResponse(req, res, { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }

    return sendResponse(req, res, { jsonrpc: '2.0', id, result });
  } catch (error) {
    console.error('MCP Error:', error);
    return sendResponse(req, res, { jsonrpc: '2.0', id, error: { code: -32603, message: error.message } });
  }
});

// GET /mcp — SSE stream (not used, return 405)
app.get('/mcp', (req, res) => {
  if (!validateSession(req, res)) return;
  return res.status(405).set('Allow', 'POST, DELETE').end();
});

// DELETE /mcp — Session termination
app.delete('/mcp', (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (sessionId && sessions.has(sessionId)) {
    sessions.delete(sessionId);
    console.log(`Session terminated: ${sessionId}`);
  }
  return res.status(200).end();
});

// Clean up stale sessions every 30 minutes
setInterval(() => {
  const staleThreshold = Date.now() - 30 * 60 * 1000;
  for (const [id, session] of sessions) {
    if (session.lastActivity < staleThreshold) {
      sessions.delete(id);
      console.log(`Stale session cleaned: ${id}`);
    }
  }
}, 30 * 60 * 1000);

// ============================================================
// Backwards-compatible SSE endpoint (MCP 2024-11-05 transport)
// ============================================================
app.get('/mcp/sse', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  res.write(`event: endpoint\ndata: /mcp\n\n`);

  const keepalive = setInterval(() => {
    res.write(`: keepalive\n\n`);
  }, 15000);

  req.on('close', () => clearInterval(keepalive));
});

app.listen(PORT, () => {
  console.log(`GLEIF MCP Service running on port ${PORT} (protocol ${PROTOCOL_VERSION})`);
  console.log(`Transport: Streamable HTTP + backwards-compat SSE`);
  console.log(`Tools (${TOOLS.length}): ${TOOLS.map(t => t.name).join(', ')}`);
});
