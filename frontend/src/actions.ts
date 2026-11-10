import { completeCard, messageOf, notifyChanged, reopenCard, undoComplete, type Card } from './api'
import { toast, toastError } from './overlays'

/** Completing a task is one tap everywhere, so it always comes with a way back. */
export async function completeWithUndo(card: Pick<Card, 'id' | 'list_id' | 'title' | 'recurrence'>) {
  try {
    const undo = await completeCard(card)
    notifyChanged()
    // A repeating task spawns its next occurrence on completion, which a simple move back would not undo.
    toast(`Completed “${card.title}”`, card.recurrence === 'none' ? { label: 'Undo', run: () => { undoComplete(undo).then(notifyChanged, () => toastError('Could not restore the task.')) } } : undefined)
    return true
  } catch (cause) {
    toastError(messageOf(cause, 'Could not complete the task.'))
    return false
  }
}

export async function reopen(card: Pick<Card, 'id'>) {
  try { await reopenCard(card); notifyChanged(); return true }
  catch (cause) { toastError(messageOf(cause, 'Could not reopen the task.')); return false }
}
