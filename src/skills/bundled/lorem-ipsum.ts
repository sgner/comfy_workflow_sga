import { registerBundledSkill } from '../bundled-registry.js'

const LOREM_IPSUM_PROMPT = `Generate filler text for long context testing. The user specified approximately $ARGUMENTS tokens of filler text. Generate that much text using common English words organized into natural-looking sentences and paragraphs. Do not use actual lorem ipsum Latin — use real English words. Each sentence should be 10-20 words. Add paragraph breaks roughly every 5-8 sentences. Cap at 500,000 tokens for safety.`

export function registerLoremIpsumSkill(): void {
  registerBundledSkill({
    name: 'lorem-ipsum',
    description: 'Generate filler text for long context testing. Specify token count as argument.',
    argumentHint: '[token_count]',
    userInvocable: true,
    prompt: LOREM_IPSUM_PROMPT,
  })
}
