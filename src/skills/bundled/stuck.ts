import { registerBundledSkill } from '../bundled-registry.js'

const STUCK_PROMPT = `# /stuck — Diagnose Frozen/Slow Sessions

The user thinks a session is frozen, stuck, or very slow. Investigate and report.

## What to Look For

Signs of a stuck session:
- **High CPU (≥90%) sustained** — likely an infinite loop
- **Very high memory (≥4GB)** — possible memory leak
- **Stuck child process** — a hung subprocess can freeze the parent
- **No response for extended period** — may be waiting on I/O

## Investigation Steps

1. **List all running processes** related to the agent framework
2. **For anything suspicious**, gather more context:
   - Child processes
   - CPU and memory usage
   - How long the process has been running
3. **Check logs** for errors or stuck indicators
4. **Report findings** with diagnosis and suggested fix

## Rules
- Don't kill or signal any processes — this is diagnostic only
- Focus on the specific issue the user reported
- Provide actionable next steps
`

export function registerStuckSkill(): void {
  registerBundledSkill({
    name: 'stuck',
    description: 'Investigate frozen/stuck/slow agent sessions and provide a diagnostic report.',
    whenToUse: 'Use when the user reports that a session appears frozen or very slow.',
    userInvocable: true,
    prompt: STUCK_PROMPT,
  })
}
