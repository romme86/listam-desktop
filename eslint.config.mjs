import tseslint from 'typescript-eslint'

// Same security lint baseline as listam-mobile: production code must not use
// raw console — diagnostics route through @listam/logging redaction.
export default [
    {
        ignores: ['node_modules/**'],
    },
    {
        files: ['src/**/*.mjs'],
        languageOptions: {
            parser: tseslint.parser,
            ecmaVersion: 'latest',
            sourceType: 'module',
        },
        rules: {
            'no-console': 'error',
        },
    },
    {
        files: ['test/**/*.mjs'],
        languageOptions: {
            parser: tseslint.parser,
            ecmaVersion: 'latest',
            sourceType: 'module',
        },
        rules: {},
    },
]
