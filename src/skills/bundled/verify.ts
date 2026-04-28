import { registerBundledSkill } from '../bundled-registry.js'

const VERIFY_PROMPT = `# Verify: Test Your Changes

Verify that a code change does what it should by running the application or tests.

## Steps

### 1. Understand What to Verify
Ask the user what they want to verify if it's not clear from context.

### 2. Determine How to Verify
Based on the project type:
- **Web app**: Start dev server, open browser, test the feature
- **CLI tool**: Run the command with test inputs
- **Library**: Run unit tests and integration tests
- **API**: Start server, make test requests

### 3. Execute Verification
- Run the relevant test suite
- If no tests exist, manually test the changed functionality
- Check for edge cases and error handling

### 4. Report Results
- What was tested
- What passed
- What failed (with details)
- Suggestions for additional tests if needed

## Rules
- Always run existing tests first
- If tests fail, investigate the cause before reporting
- Suggest specific test cases for untested scenarios
- Be thorough but focused on the changed functionality
`

export function registerVerifySkill(): void {
  registerBundledSkill({
    name: 'verify',
    description: 'Verify a code change does what it should by running the app or tests.',
    whenToUse: 'Use when the user wants to verify that their changes work correctly.',
    userInvocable: true,
    prompt: VERIFY_PROMPT,
  })
}
