import { WorkingSet, DEFAULT_WORKING_SET_CONFIG, type WorkingSetConfig } from './working-set.js'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('working-set-registry')

let workingSetInstance: WorkingSet | null = null

export function initWorkingSet(config?: WorkingSetConfig): WorkingSet {
  workingSetInstance = new WorkingSet(config ?? DEFAULT_WORKING_SET_CONFIG)
  logger.info('WorkingSet initialized')
  return workingSetInstance
}

export function getWorkingSet(): WorkingSet | null {
  return workingSetInstance
}

export function setWorkingSet(ws: WorkingSet): void {
  workingSetInstance = ws
}

export function resetWorkingSet(): void {
  if (workingSetInstance) {
    workingSetInstance.clear()
  }
  workingSetInstance = null
}
