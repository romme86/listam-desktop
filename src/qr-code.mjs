import qrcode from 'qrcode-generator'

const SVG_NS = 'http://www.w3.org/2000/svg'
const QUIET_ZONE_MODULES = 4
const MODULE_SIZE_PX = 4

/**
 * Build the scanner-facing matrix separately from the DOM renderer so invite
 * payload integrity and QR geometry can be checked in Node tests.
 */
export function createInviteQrMatrix(value) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError('invite QR value must be a non-empty string')
    }

    const qr = qrcode(0, 'M')
    qr.addData(value, 'Byte')
    qr.make()

    const moduleCount = qr.getModuleCount()
    const modules = Array.from({ length: moduleCount }, (_, row) =>
        Array.from({ length: moduleCount }, (_, col) => qr.isDark(row, col)))

    return { moduleCount, modules }
}

/**
 * Render a typed invite payload as a crisp, dependency-local SVG. A permanent
 * white field and the standard four-module quiet zone keep it scannable in
 * both app themes; the encoded value never leaves the device.
 */
export function createInviteQr(value, label) {
    const { moduleCount, modules } = createInviteQrMatrix(value)
    const totalModules = moduleCount + QUIET_ZONE_MODULES * 2
    const renderedSize = totalModules * MODULE_SIZE_PX

    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.classList.add('invite-qr')
    svg.setAttribute('viewBox', `0 0 ${totalModules} ${totalModules}`)
    svg.setAttribute('width', String(renderedSize))
    svg.setAttribute('height', String(renderedSize))
    svg.setAttribute('role', 'img')
    svg.setAttribute('aria-label', label)
    svg.setAttribute('focusable', 'false')
    svg.setAttribute('shape-rendering', 'crispEdges')

    const background = document.createElementNS(SVG_NS, 'rect')
    background.setAttribute('width', String(totalModules))
    background.setAttribute('height', String(totalModules))
    background.setAttribute('fill', '#ffffff')
    svg.append(background)

    const darkModules = document.createElementNS(SVG_NS, 'path')
    let path = ''
    for (let row = 0; row < moduleCount; row += 1) {
        for (let col = 0; col < moduleCount; col += 1) {
            if (!modules[row][col]) continue
            const x = col + QUIET_ZONE_MODULES
            const y = row + QUIET_ZONE_MODULES
            path += `M${x} ${y}h1v1h-1z`
        }
    }
    darkModules.setAttribute('d', path)
    darkModules.setAttribute('fill', '#111111')
    svg.append(darkModules)

    const frame = document.createElement('div')
    frame.className = 'invite-qr-frame'
    frame.append(svg)
    return frame
}
