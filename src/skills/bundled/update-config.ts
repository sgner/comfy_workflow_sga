import { registerBundledSkill } from '../bundled-registry.js'

const UPDATE_CONFIG_PROMPT = `# Update Config Skill

Modify configuration by updating settings files.

## CRITICAL: Read Before Write

**Always read the existing settings file before making changes.** Merge new settings with existing ones - never replace the entire file.

## CRITICAL: Use AskUserQuestion for Ambiguity

When the user's request is ambiguous, use AskUserQuestion to clarify:
- Which settings file to modify
- Whether to add to existing arrays or replace them
- Specific values when multiple options exist

## Decision: Config Tool vs Direct Edit

**Use the Config tool** for simple settings like theme, model, language.

**Edit settings files directly** for:
- Hooks (PreToolUse, PostToolUse, etc.)
- Complex permission rules
- Environment variables
- MCP server configuration
- Plugin configuration

## Workflow

1. **Clarify intent** - Ask if the request is ambiguous
2. **Read existing file** - Use Read tool on the target settings file
3. **Merge carefully** - Preserve existing settings, especially arrays
4. **Edit file** - Use Edit tool
5. **Confirm** - Tell user what was changed

## Merging Arrays (Important!)

When adding to arrays, **merge with existing**, don't replace.

## Hook Events

| Event | Matcher | Purpose |
|-------|---------|---------|
| PreToolUse | Tool name | Run before tool, can block |
| PostToolUse | Tool name | Run after successful tool |
| PostToolUseFailure | Tool name | Run after tool fails |
| Stop | - | Run when agent stops |
| SessionStart | - | When session starts |

## Common Patterns

**Auto-format after writes:**
\`\`\`json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Write|Edit",
      "hooks": [{
        "type": "command",
        "command": "prettier --write $FILE 2>/dev/null || true"
      }]
    }]
  }
}
\`\`\`

**Run tests after code changes:**
\`\`\`json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Write|Edit",
      "hooks": [{
        "type": "command",
        "command": "npm test 2>/dev/null || true"
      }]
    }]
  }
}
\`\`\`
`

export function registerUpdateConfigSkill(): void {
  registerBundledSkill({
    name: 'update-config',
    description: 'Configure the agent framework via settings files. Handles hooks, permissions, environment variables, and MCP configuration.',
    whenToUse: 'Use when the user wants to modify configuration, add hooks, set permissions, or configure MCP servers.',
    allowedTools: ['Read'],
    userInvocable: true,
    prompt: UPDATE_CONFIG_PROMPT,
  })
}
