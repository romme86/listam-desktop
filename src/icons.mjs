// Category glyphs for the desktop list/grid. The canonical category keys come
// from @listam/grocery; the glyphs are desktop-local presentation only (the
// mobile icon map is a generated, app-local asset and is not shared yet).
const CATEGORY_GLYPHS = {
    'Fruits': '\u{1F34E}',
    'Vegetables': '\u{1F955}',
    'Bread & Bakery': '\u{1F35E}',
    'Deli': '\u{1F953}',
    'Meat': '\u{1F356}',
    'Fish & Seafood': '\u{1F41F}',
    'Dairy': '\u{1F95B}',
    'Canned Goods': '\u{1F96B}',
    'Pasta/Rice/Cereal': '\u{1F35D}',
    'Condiments & Spices': '\u{1F9C2}',
    'Baking': '\u{1F9C1}',
    'Snacks': '\u{1F968}',
    'Beverages': '\u{1F9C3}',
    'Frozen Foods': '\u{1F9CA}',
    'Ready Meals': '\u{1F371}',
    'International Foods': '\u{1F30D}',
    'Health & Organic': '\u{1F33F}',
    'Personal Care': '\u{1F9FC}',
    'Household & Cleaning': '\u{1F9F9}',
    'Baby Items': '\u{1F37C}',
    'Pet Care': '\u{1F436}',
    'Others': '\u{1F6D2}',
}

export function categoryGlyph(canonicalKey) {
    return CATEGORY_GLYPHS[canonicalKey] ?? CATEGORY_GLYPHS.Others
}
