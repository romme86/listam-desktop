import tseslint from 'typescript-eslint'

// Same security lint baseline as listam-mobile: production code must not use
// raw console — diagnostics route through @listam/logging redaction.
export default [
    {
        // pear-smoke contains symlinks back into src/ and node_modules/ so the
        // Bare smoke app can resolve them; linting it would double-lint src.
        ignores: ['node_modules/**', 'test/pear-smoke/**'],
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
