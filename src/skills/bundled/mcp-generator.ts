import { registerBundledSkill } from '../bundled-registry.js'

const MCP_GENERATOR_PROMPT = `# MCP Server Generator

Generate a new MCP (Model Context Protocol) server configuration based on the user's requirements.

## Your Task

### Step 1: Understand Requirements

Ask the user what they want the MCP server to do. Key questions:
1. What external service or tool should the MCP server connect to?
2. What operations/tools should it expose?
3. What transport type is preferred? (stdio, sse, streamable-http)
4. Is there an existing MCP server package available, or does one need to be created?

### Step 2: Determine Configuration

Based on the requirements, determine:
- **Transport**: stdio (for local CLI tools), sse/streamable-http (for remote services)
- **Command**: The command to start the server (for stdio)
- **URL**: The server URL (for sse/streamable-http)
- **Environment variables**: API keys, configuration values
- **Always-allow tools**: Which tools should be auto-approved

### Step 3: Generate Configuration

Create the MCP server configuration in JSON format:

\`\`\`json
{
  "name": "server-name",
  "command": "npx",
  "args": ["-y", "@example/mcp-server"],
  "env": {
    "API_KEY": "your-api-key"
  },
  "transport": "stdio",
  "alwaysAllow": ["tool1", "tool2"]
}
\`\`\`

### Step 4: Register and Connect

Use the available tools to:
1. Register the MCP server via the API: POST /api/v1/mcp/servers
2. Connect to the server: POST /api/v1/mcp/servers/{name}/connect
3. Verify the tools are available: GET /api/v1/mcp/tools

### Step 5: Save Configuration

Save the configuration to the user's config file so it persists across restarts.

## Common MCP Server Patterns

### Database Access
\`\`\`json
{
  "name": "postgres",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"],
  "transport": "stdio"
}
\`\`\`

### File System
\`\`\`json
{
  "name": "filesystem",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
  "transport": "stdio"
}
\`\`\`

### GitHub
\`\`\`json
{
  "name": "github",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxx" },
  "transport": "stdio"
}
\`\`\`

### Remote SSE Server
\`\`\`json
{
  "name": "remote-api",
  "url": "https://api.example.com/mcp",
  "transport": "sse",
  "headers": { "Authorization": "Bearer xxx" }
}
\`\`\`
`

export function registerMCPGeneratorSkill(): void {
  registerBundledSkill({
    name: 'mcp-generator',
    description: 'Generate and configure a new MCP server based on user requirements. Handles discovery, configuration, registration, and connection.',
    whenToUse: 'Use when the user wants to add a new MCP server or connect to an external service via MCP.',
    allowedTools: ['Read', 'Write', 'Bash', 'AskUserQuestion', 'WebFetch'],
    userInvocable: true,
    disableModelInvocation: true,
    argumentHint: '[description of the MCP server you want to add]',
    prompt: MCP_GENERATOR_PROMPT,
  })
}
