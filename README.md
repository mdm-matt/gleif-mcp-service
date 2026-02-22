# GLEIF MCP Service

MCP server wrapping the [GLEIF public API](https://www.gleif.org/en/lei-data/gleif-api) for Legal Entity Identifier (LEI) lookup, entity search, fuzzy matching, and corporate relationship discovery.

Built with Express.js and the [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http) (2025-06-18 protocol), deployable to Cloud Run.

## Live Service

```
https://gleif-mcp-service-826393174249.us-central1.run.app
```

### Connect as MCP Server

Add to your MCP client config:

```json
{
  "mcpServers": {
    "gleif": {
      "type": "url",
      "url": "https://gleif-mcp-service-826393174249.us-central1.run.app/mcp"
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `search_lei` | Search LEI records by entity legal name |
| `get_lei` | Get a specific LEI record by 20-character LEI code |
| `fuzzy_search` | Fuzzy name matching (handles typos and partial names) |
| `autocomplete` | Fast prefix-based autocomplete for entity names |
| `search_by_bic` | Search by BIC / SWIFT code |
| `search_by_isin` | Search by ISIN (securities identifier) |
| `get_direct_parent` | Get direct parent entity |
| `get_ultimate_parent` | Get ultimate parent entity |
| `get_direct_children` | Get subsidiary entities |

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/tools` | List all tools and schemas |
| `POST` | `/tools/:toolName` | REST API — call any tool |
| `POST` | `/mcp` | MCP Streamable HTTP transport |
| `GET` | `/mcp/sse` | Backwards-compatible SSE transport |
| `GET` | `/openapi.json` | OpenAPI 3.0 spec |

## REST API Examples

**Search by name:**
```bash
curl -X POST https://gleif-mcp-service-826393174249.us-central1.run.app/tools/search_lei \
  -H 'Content-Type: application/json' \
  -d '{"legalName": "Microsoft"}'
```

**Get by LEI:**
```bash
curl -X POST .../tools/get_lei \
  -d '{"lei": "INR2EJN1ERAN0W5ZP974"}'
```

**BIC lookup:**
```bash
curl -X POST .../tools/search_by_bic \
  -d '{"bic": "CHASUS33XXX"}'
```

**Corporate hierarchy:**
```bash
curl -X POST .../tools/get_direct_children \
  -d '{"lei": "INR2EJN1ERAN0W5ZP974", "page_size": 5}'
```

## Local Development

```bash
npm install
npm start
# Server runs on http://localhost:8080
```

## Deploy to Cloud Run

```bash
gcloud run deploy gleif-mcp-service \
  --source . \
  --region us-central1 \
  --project gcp-infa-cloud-alliances-bus-d \
  --allow-unauthenticated
```

## Architecture

Single `server.js` file with:
- **GLEIF API helper** — `gleifGet()` for GET requests to `api.gleif.org/api/v1`
- **Response transformers** — flatten verbose JSON:API responses into clean objects
- **9 tool definitions** with JSON Schema input validation
- **MCP transport** — Streamable HTTP with session management and stale cleanup
- **REST API** — `POST /tools/:toolName` for direct integration
- **OpenAPI spec** — auto-generated from tool definitions

No authentication required — the GLEIF API is free and public.
