import { h } from '../dom.mjs'
import { inlineMarkdownToHtml, htmlToMarkdown } from '@listam/domain/markdown'

const hasText = (value) => typeof value === 'string' && value.replace(/[\u200b\u00a0]/g, ' ').trim().length > 0

// An intentional divider is content. Empty editable payloads are not.
export function isEmptyBlock(block) {
    switch (block?.type) {
        case 'divider': return false
        case 'checklist':
        case 'numberedList': return !(block.items || []).some((row) => hasText(row.text))
        case 'links': return !(block.links || []).some((row) => hasText(row.label) || hasText(row.url))
        case 'image': return !hasText(block.url) && !hasText(block.alt)
        case 'table': return !(block.rows || []).some((row) => row.some(hasText))
        default: return !hasText(block?.text)
    }
}

export function cleanBlockDraft(block) {
    if (block.type === 'checklist' || block.type === 'numberedList') return { ...block, items: block.items.filter((row) => hasText(row.text)) }
    if (block.type === 'links') return { ...block, links: block.links.filter((row) => hasText(row.label) || hasText(row.url)) }
    return block
}

// The live payload stays structured. Markdown is only its storage format, never
// an editing surface. The parent owns the draft and focus across store updates.
export function renderStructuredBlockEditor({ block, draft, focus, setFocus, changed, redraw, commit, cancel, exitList, t, rich }) {
    const wrap = h('div', { class: 'block-editor-wrap block-structured-editor' })
    const fields = new Map()
    const remember = (key, field) => setFocus({ key, offset: field.isContentEditable ? rich.offset(field) : field.selectionStart })
    const blur = (event) => {
        if (wrap.contains(event.relatedTarget)) return
        queueMicrotask(() => {
            if (document.activeElement?.closest(`[data-block-id="${block.id}"]`)?.classList.contains('editing')) return
            commit()
        })
    }
    const commonKeys = (event) => {
        if (event.key === 'Escape') { event.stopPropagation(); cancel(); return true }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); commit(); return true }
        return false
    }
    const textField = (key, value, label, update) => {
        const field = h('input', {
            id: `block-${block.id}-${key}`, class: 'block-field', type: 'text', value,
            'aria-label': label, placeholder: label,
            oninput: (event) => { update(field.value); remember(key, field); if (!event.isComposing) changed() },
            onkeyup: () => remember(key, field),
            onkeydown: commonKeys, onblur: blur,
        })
        fields.set(key, field)
        return field
    }
    const button = (label, run) => h('button', {
        class: 'block-row-action label-sm', type: 'button', 'aria-label': label,
        onmousedown: (event) => event.preventDefault(), onclick: run,
    }, label)

    if (block.type === 'checklist' || block.type === 'numberedList') {
        const checklist = block.type === 'checklist'
        if (!draft.items.length) draft.items.push(checklist ? { text: '', done: false } : { text: '' })
        const list = h(checklist ? 'ul' : 'ol', { class: checklist ? 'block-checklist' : 'block-numbered' })
        draft.items.forEach((row, index) => {
            const key = `item-${index}`
            const field = h('div', {
                id: `block-${block.id}-${key}`, class: 'block-list-text block-rich', contenteditable: 'true',
                role: 'textbox', 'aria-label': t('ticket.block.item'), 'data-placeholder': t('ticket.block.item'),
                onkeyup: () => remember(key, field), onmouseup: () => remember(key, field),
                onblur: blur,
            })
            field.innerHTML = inlineMarkdownToHtml(row.text || '')
            rich.seed(field)
            fields.set(key, field)
            field.addEventListener('input', (event) => {
                if (event.isComposing) return
                rich.inlineRules()
                row.text = htmlToMarkdown(field.innerHTML)
                remember(key, field)
                changed()
            })
            field.addEventListener('paste', (event) => {
                event.preventDefault()
                const text = event.clipboardData?.getData('text/plain') || ''
                const lines = text.split(/\r?\n/)
                if (lines.length === 1) { document.execCommand('insertText', false, text); return }
                const at = rich.offset(field) ?? (field.textContent || '').length
                const before = (field.textContent || '').slice(0, at)
                const after = (field.textContent || '').slice(at)
                const items = lines.map((line, i) => ({ text: `${i === 0 ? before : ''}${line}${i === lines.length - 1 ? after : ''}`, ...(checklist ? { done: i === 0 && !!row.done } : {}) }))
                draft.items.splice(index, 1, ...items)
                setFocus({ key: `item-${index + items.length - 1}`, offset: lines.at(-1).length })
                if (!changed()) redraw()
            })
            field.addEventListener('keydown', (event) => {
                if (commonKeys(event) || event.isComposing) return
                if ((event.metaKey || event.ctrlKey) && ['b', 'i'].includes(event.key.toLowerCase())) {
                    event.preventDefault()
                    document.execCommand(event.key.toLowerCase() === 'b' ? 'bold' : 'italic')
                    row.text = htmlToMarkdown(field.innerHTML)
                    remember(key, field)
                    return
                }
                if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    if (!hasText(row.text)) {
                        draft.items.splice(index, 1)
                        exitList(index)
                        return
                    }
                    const selection = window.getSelection()
                    if (!selection?.rangeCount) return
                    const range = selection.getRangeAt(0)
                    const left = range.cloneRange(), right = range.cloneRange()
                    left.selectNodeContents(field); left.setEnd(range.startContainer, range.startOffset)
                    right.selectNodeContents(field); right.setStart(range.endContainer, range.endOffset)
                    const serialize = (part) => { const box = document.createElement('div'); box.append(part.cloneContents()); return htmlToMarkdown(box.innerHTML) }
                    row.text = serialize(left)
                    draft.items.splice(index + 1, 0, { text: serialize(right), ...(checklist ? { done: false } : {}) })
                    setFocus({ key: `item-${index + 1}`, offset: 0 })
                    redraw()
                } else if (event.key === 'Backspace' && !hasText(row.text)) {
                    event.preventDefault()
                    draft.items.splice(index, 1)
                    if (changed()) return
                    setFocus({ key: `item-${Math.min(index, draft.items.length - 1)}`, offset: 0 })
                    redraw()
                }
            })
            const checkbox = checklist ? h('input', {
                type: 'checkbox', checked: row.done ? '' : null, 'aria-label': t('ticket.block.completed'),
                onchange: (event) => { row.done = event.target.checked; li.classList.toggle('done', row.done) },
                onblur: blur,
            }) : null
            const li = h('li', { class: row.done ? 'done' : '' }, checkbox, field)
            list.append(li)
        })
        wrap.append(list)
    } else if (block.type === 'links') {
        if (!draft.links.length) draft.links.push({ label: '', url: '' })
        for (const [index, link] of draft.links.entries()) {
            wrap.append(h('div', { class: 'block-link-fields' },
                textField(`label-${index}`, link.label, t('ticket.block.linkLabel'), (v) => { link.label = v }),
                textField(`url-${index}`, link.url, t('ticket.block.linkUrl'), (v) => { link.url = v }),
                button(t('common.remove'), () => {
                    draft.links.splice(index, 1)
                    if (changed()) return
                    setFocus({ key: `label-${Math.min(index, draft.links.length - 1)}`, offset: 0 }); redraw()
                }),
            ))
        }
        wrap.append(button(t('ticket.block.addLink'), () => {
            draft.links.push({ label: '', url: '' }); setFocus({ key: `label-${draft.links.length - 1}`, offset: 0 }); redraw()
        }))
    } else if (block.type === 'image') {
        const preview = h('img', { class: 'block-image', alt: draft.alt || '' })
        const showPreview = () => {
            const safe = /^(https?:\/\/|data:image\/)/i.test(draft.url || '')
            preview.hidden = !safe
            if (safe) preview.src = draft.url
            else preview.removeAttribute('src')
            preview.alt = draft.alt || ''
        }
        showPreview()
        wrap.append(preview,
            textField('url', draft.url, t('ticket.block.imageUrl'), (v) => { draft.url = v; showPreview() }),
            textField('alt', draft.alt, t('ticket.block.imageAlt'), (v) => { draft.alt = v; showPreview() }),
        )
    }
    queueMicrotask(() => {
        if (!wrap.isConnected) return
        const target = fields.get(focus?.key) || fields.values().next().value
        if (!target || wrap.contains(document.activeElement)) return
        target.focus()
        const offset = focus?.offset ?? (target.isContentEditable ? target.textContent.length : target.value.length)
        if (target.isContentEditable) rich.setOffset(target, offset)
        else target.setSelectionRange(offset, offset)
    })
    return wrap
}
