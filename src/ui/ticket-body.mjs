import { TICKET_TASKS_BLOCK_ID } from '@listam/domain/board'

// Creation tasks use the same body block editor as any other todo list. Keep
// the legacy checklist as a write-side mirror for older peers' rigor rules;
// changing those rules inside apply() would diverge replicated views.
export function seedTicketTasks(checklist, blocks = []) {
    const rest = (Array.isArray(blocks) ? blocks : []).filter((block) => block?.id !== TICKET_TASKS_BLOCK_ID)
    const items = (Array.isArray(checklist) ? checklist : []).filter((task) => typeof task?.text === 'string' && task.text.trim())
        .map((task) => ({ text: task.text, done: !!task.done }))
    return items.length ? [{ id: TICKET_TASKS_BLOCK_ID, type: 'checklist', items }, ...rest] : rest
}

// Existing cards gain the body list on open. Do not replace a list already
// edited or reordered in the body, or discard unfamiliar future block types.
export function foldTicketTasks(item, blocks = item.blocks || []) {
    if (!Array.isArray(blocks)) blocks = []
    if (blocks.some((block) => block?.id === TICKET_TASKS_BLOCK_ID)) return blocks
    return seedTicketTasks(item.checklist, blocks)
}

export function ticketBodyFields(item, blocks) {
    const tasks = blocks.find((block) => block.id === TICKET_TASKS_BLOCK_ID)
    const hadTasks = item.checklist?.length || (Array.isArray(item.blocks) && item.blocks.some((block) => block?.id === TICKET_TASKS_BLOCK_ID))
    if (!tasks && !hadTasks) return { blocks }
    const checklist = (tasks?.type === 'checklist' ? tasks.items || [] : [])
        .filter((task) => typeof task?.text === 'string' && task.text.trim())
        .map((task, index) => ({ id: `task-${index}`, text: task.text, done: !!task.done }))
    return { blocks, checklist }
}
