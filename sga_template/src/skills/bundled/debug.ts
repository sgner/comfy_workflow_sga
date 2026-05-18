import { registerBundledSkill } from '../bundled-registry.js'

const DEBUG_PROMPT = `# Debug Skill

Help the user debug an issue they're encountering in the current session.

## Steps

1. **Review the user's issue description** — understand what went wrong
2. **Check for common issues:**
   - Look at error messages and stack traces
   - Check recent file changes
   - Verify configuration files
   - Check for missing dependencies
3. **Investigate systematically:**
   - Read relevant source files
   - Search for error patterns in logs
   - Check environment and configuration
4. **Explain what you found** in plain language
5. **Suggest concrete fixes or next steps**

## Common Debugging Patterns

- **Type errors**: Check type definitions, imports, and API changes
- **Runtime errors**: Look at stack traces, check null/undefined values
- **Build errors**: Check dependencies, configuration, and file paths
- **Permission errors**: Check file permissions and access control
- **Network errors**: Check URLs, API keys, and connectivity
`

export function registerDebugSkill(): void {
  registerBundledSkill({
    name: 'debug',
    description: 'Debug issues in the current session by reading logs, checking configurations, and diagnosing problems.',
    whenToUse: 'Use when the user wants to debug an issue or error they are encountering.',
    allowedTools: ['Read', 'Grep', 'Glob'],
    argumentHint: '[issue description]',
    userInvocable: true,
    disableModelInvocation: true,
    prompt: DEBUG_PROMPT,
  })
}
