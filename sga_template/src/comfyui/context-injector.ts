import type { Message } from '../core/types.js'
import { getWorkingSet } from '../memory/working-set-registry.js'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('comfyui-context-injector')

export class ComfyUIContextInjector {
  async onSessionStart(messages: Message[]): Promise<void> {
    const ws = getWorkingSet()
    if (!ws) return

    try {
      await ws.fadeExpired()
      const anchors = ws.list()
      if (anchors.length === 0) {
        const lastUserMsg = messages
          .filter(m => m.role === 'user')
          .pop()
        if (lastUserMsg) {
          const msgText = lastUserMsg.content
            .filter(c => c.type === 'text' && c.text)
            .map(c => c.text!)
            .join('\n')
          ws.detectAndPinFromContent(msgText, 'session-start')
        }
      }
    } catch (err) {
      logger.debug(`Session-start working set init skipped: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  injectWorkflowSummary(messages: Message[]): boolean {
    const ws = getWorkingSet()
    if (!ws) return false

    try {
      const summaryAnchors = ws.list().filter(a => a.id.startsWith('workflow-summary-'))
      if (summaryAnchors.length === 0) return false

      const summaryText = summaryAnchors.map(a => a.content).join('\n')
      const lastUserIdx = messages.reduce((acc, m, i) => m.role === 'user' ? i : acc, -1)
      if (lastUserIdx < 0) return false

      messages[lastUserIdx].content.push({
        type: 'text',
        text: `\n[Current Workflow Context]\n${summaryText}`,
      })
      return true
    } catch (err) {
      logger.debug(`Workflow context injection skipped: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }
}
