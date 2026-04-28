export { BashTool } from './bash.js'
export { FileReadTool } from './file-read.js'
export { FileEditTool } from './file-edit.js'
export { FileWriteTool } from './file-write.js'
export { GrepTool } from './grep.js'
export { GlobTool } from './glob.js'
export { WebSearchTool } from './web-search.js'
export { WebFetchTool } from './web-fetch.js'
export { TodoWriteTool, getSessionTodos, setSessionTodos, type TodoItem } from './todo-write.js'
export { AskUserQuestionTool, type QuestionOption } from './ask-user-question.js'
export { NotebookEditTool } from './notebook-edit.js'
export { SkillTool } from './skill.js'
export { LSPTool } from './lsp.js'

import { BashTool } from './bash.js'
import { FileReadTool } from './file-read.js'
import { FileEditTool } from './file-edit.js'
import { FileWriteTool } from './file-write.js'
import { GrepTool } from './grep.js'
import { GlobTool } from './glob.js'
import { WebSearchTool } from './web-search.js'
import { WebFetchTool } from './web-fetch.js'
import { TodoWriteTool } from './todo-write.js'
import { AskUserQuestionTool } from './ask-user-question.js'
import { NotebookEditTool } from './notebook-edit.js'
import { SkillTool } from './skill.js'
import { LSPTool } from './lsp.js'
import type { Tool } from '../base.js'

export function createBuiltinTools(): Tool[] {
  return [
    new BashTool(),
    new FileReadTool(),
    new FileEditTool(),
    new FileWriteTool(),
    new GrepTool(),
    new GlobTool(),
    new WebSearchTool(),
    new WebFetchTool(),
    new TodoWriteTool(),
    new AskUserQuestionTool(),
    new NotebookEditTool(),
    new SkillTool(),
    new LSPTool(),
  ]
}
