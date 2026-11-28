import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import i18next from 'eslint-plugin-i18next'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'src/routeTree.gen.ts', 'src/lib/api/schema.gen.ts'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: { ecmaVersion: 2022, globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Every word the app shows comes from src/locales (see lib/i18n): no
    // text written straight into components. Tests, the design-system page
    // (a developer tool) and generated files are exempt.
    files: ['src/**/*.tsx'],
    ignores: ['src/**/*.test.tsx', 'src/routes/_app/design-system.tsx'],
    plugins: { i18next },
    rules: {
      'i18next/no-literal-string': [
        'error',
        {
          mode: 'jsx-text-only',
          'jsx-components': { exclude: ['Trans', 'code', 'kbd', 'pre'] },
          words: {
            exclude: [
              '[0-9!-/:-@[-`{-~\\s·•—–…×→←›‹°%]+',
              'Supermixer', 'Supabase', 'Postgres', 'PostgreSQL', 'PostgREST', 'Supavisor', 'GraphQL', 'GraphiQL', 'SQL', 'JSON', 'CSV',
              'URL', 'URI', 'API', 'JWT', 'S3', 'Docker', 'Envoy', 'Vault', 'GitHub', 'Google', 'OK', 'RLS', 'psql', 'MFA', 'SSO', 'OIDC', 'SAML',
            ],
          },
        },
      ],
    },
  },
)
