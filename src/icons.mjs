// Tabler outline icons (vendored path data in tabler-icons.mjs, MIT) replace
// the emoji glyph set: stroke icons inherit currentColor, so category marks
// and nav icons recolor with the theme like every other ink. The canonical
// category keys come from @listam/grocery; the icon mapping is desktop-local
// presentation only.
import { TABLER_PATHS } from './tabler-icons.mjs'

const SVG_NS = 'http://www.w3.org/2000/svg'

export function tablerIcon(name, { size = 16, className = '' } = {}) {
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('width', String(size))
    svg.setAttribute('height', String(size))
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '2')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    svg.setAttribute('aria-hidden', 'true')
    svg.classList.add('ti-svg')
    if (className) for (const cls of className.split(' ')) svg.classList.add(cls)
    svg.innerHTML = TABLER_PATHS[name] ?? TABLER_PATHS.basket
    return svg
}

const CATEGORY_ICONS = {
    'Fruits': 'apple',
    'Vegetables': 'carrot',
    'Bread & Bakery': 'baguette',
    'Deli': 'sausage',
    'Meat': 'meat',
    'Fish & Seafood': 'fish',
    'Dairy': 'milk',
    'Canned Goods': 'package',
    'Pasta/Rice/Cereal': 'grain',
    'Condiments & Spices': 'salt',
    'Baking': 'cake',
    'Snacks': 'cookie',
    'Beverages': 'bottle',
    'Frozen Foods': 'snowflake',
    'Ready Meals': 'soup',
    'International Foods': 'world',
    'Health & Organic': 'leaf',
    'Personal Care': 'bath',
    'Household & Cleaning': 'spray',
    'Baby Items': 'baby-bottle',
    'Pet Care': 'dog',
    'Others': 'basket',
}

export function categoryIcon(canonicalKey, options) {
    return tablerIcon(CATEGORY_ICONS[canonicalKey] ?? CATEGORY_ICONS.Others, options)
}
