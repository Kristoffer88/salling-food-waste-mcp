# Salling Food Waste MCP Server

Find discounted food waste from Danish supermarkets (Salling Group) via the [Model Context Protocol](https://modelcontextprotocol.io/).

**Live endpoint:** `https://salling-food-waste-mcp-production.up.railway.app/mcp`

## Tools

| Tool | Description |
|------|-------------|
| `search_food_waste` | Find nearby stores with clearance items. Accepts ZIP code, GPS coordinates, or Danish address. |
| `get_store_food_waste` | Get all discounted products for a specific store by Salling store ID. |

## Connect to your AI assistant

### ChatGPT

Requires Plus, Team, Business, Enterprise, or Education plan with Developer Mode enabled.

1. In a chat, click the **"+"** icon in the input area
2. Select **"Developer Mode"**
3. Click **"Add sources"**
4. Enter the server URL:
   ```
   https://salling-food-waste-mcp-production.up.railway.app/mcp
   ```
5. Check **"I trust this application"** and click **Create**

### Claude.ai

Requires Pro, Max, Team, or Enterprise plan.

1. Go to **Settings > Connectors** ([direct link](https://claude.ai/settings/connectors))
2. Click **"Add custom connector"**
3. Enter the server URL:
   ```
   https://salling-food-waste-mcp-production.up.railway.app/mcp
   ```
4. Click **Add**
5. In chat, click the **Search and Tools** icon to enable the connector

### Claude Desktop

#### Option A: Connectors UI (recommended)

Same as Claude.ai above — open **Settings > Connectors > Add custom connector** and enter the URL.

#### Option B: Config file

Edit your config file:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "madspild": {
      "command": "npx",
      "args": [
        "mcp-remote@latest",
        "https://salling-food-waste-mcp-production.up.railway.app/mcp"
      ]
    }
  }
}
```

Restart Claude Desktop after saving.

### Claude Code

```bash
claude mcp add --transport http --scope user madspild https://salling-food-waste-mcp-production.up.railway.app/mcp
```

Or add to `.mcp.json` in your project:

```json
{
  "mcpServers": {
    "madspild": {
      "type": "http",
      "url": "https://salling-food-waste-mcp-production.up.railway.app/mcp"
    }
  }
}
```

## Rate limits

- **Per IP:** 10 requests per minute (HTTP 429 with `Retry-After` header)
- **Daily:** Soft cap at 9,500 requests/day (Salling API hard limit is 10,000)
- The server respects `Retry-After` headers from the Salling API to avoid quarantine

## Bring your own API key (HTTP mode)

When using the public HTTP endpoint, you can supply your own [Salling API key](https://developer.sallinggroup.com/) via the `X-Salling-API-Key` header. This bypasses the server's shared quota so you aren't affected by other users' traffic.

```bash
curl -X POST https://salling-food-waste-mcp-production.up.railway.app/mcp \
  -H "Content-Type: application/json" \
  -H "X-Salling-API-Key: YOUR_KEY_HERE" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

If the header is omitted, the server falls back to its built-in key.

## Self-hosting

Create `.env`:

```
SALLING_API_KEY=your_key_here
POSTHOG_API_KEY=your_posthog_key_here  # optional
```

Get a Salling API key at [developer.sallinggroup.com](https://developer.sallinggroup.com/).

```bash
npm install

# HTTP mode (for deployment)
npx tsx src/mcp-server.ts --http

# Stdio mode (for local Claude Desktop/Code)
npx tsx src/mcp-server.ts
```
