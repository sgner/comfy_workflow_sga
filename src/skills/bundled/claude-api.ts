import { registerBundledSkill } from '../bundled-registry.js'

const CLAUDE_API_PROMPT = `# Claude API Skill

Build apps with the Claude API or Anthropic SDK.

## Quick Task Reference

**Single text classification/summarization/extraction/Q&A:**
→ Use the Messages API with the appropriate model

**Chat UI or real-time response display:**
→ Use the streaming API

**Function calling / tool use / agents:**
→ Use tool_use with function definitions

**Batch processing (non-latency-sensitive):**
→ Use the Messages Batch API

## Common Patterns

### Basic API Call
\`\`\`typescript
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic()
const message = await client.messages.create({
  model: 'claude-sonnet-4-20250514',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello' }],
})
\`\`\`

### Streaming
\`\`\`typescript
const stream = client.messages.stream({
  model: 'claude-sonnet-4-20250514',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello' }],
})
for await (const event of stream) {
  // handle streaming events
}
\`\`\`

### Tool Use
\`\`\`typescript
const message = await client.messages.create({
  model: 'claude-sonnet-4-20250514',
  max_tokens: 1024,
  tools: [{
    name: 'get_weather',
    description: 'Get weather for a location',
    input_schema: {
      type: 'object',
      properties: { location: { type: 'string' } },
      required: ['location'],
    },
  }],
  messages: [{ role: 'user', content: 'What is the weather in SF?' }],
})
\`\`\`

## Error Handling
- 400: Invalid request
- 401: Invalid API key
- 403: Forbidden
- 404: Not found
- 429: Rate limited
- 500: Internal server error
- 529: Overloaded

Always implement retry logic with exponential backoff for 429 and 5xx errors.
`

export function registerClaudeApiSkill(): void {
  registerBundledSkill({
    name: 'claude-api',
    description: 'Build apps with the Claude API or Anthropic SDK. Trigger when code imports anthropic/@anthropic-ai/sdk or user asks about Claude API usage.',
    whenToUse: 'Use when the user wants to build applications using the Claude API or Anthropic SDK.',
    allowedTools: ['Read', 'Grep', 'Glob', 'WebFetch'],
    userInvocable: true,
    prompt: CLAUDE_API_PROMPT,
  })
}
