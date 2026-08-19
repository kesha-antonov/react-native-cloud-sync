import js from '@eslint/js'
import stylistic from '@stylistic/eslint-plugin'
import tseslint from 'typescript-eslint'
import importPlugin from 'eslint-plugin-import'

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/lib/**',
      '**/build/**',
      'example/**',
      // Separate Yarn projects with their own tooling.
      'website/**',
      'plugin/build/**',
      '__mocks__/**',
      'eslint.config.mjs',
      'jest.config.cjs',
      'babel.config.cjs',
      'react-native.config.js',
      // Build tooling, not library source.
      'scripts/**',
      'app.plugin.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  stylistic.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: './tsconfig.json',
      },
      globals: {
        __DEV__: 'readonly',
        NodeJS: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      import: importPlugin,
    },
    settings: {
      'import/ignore': ['react-native'],
    },
    rules: {
      // TypeScript rules
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/method-signature-style': ['error', 'property'],
      '@typescript-eslint/no-unused-expressions': [
        'error',
        { allowShortCircuit: true, allowTernary: true },
      ],

      // Core ESLint rules
      curly: ['error', 'multi', 'consistent'],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-var': 'error',
      'prefer-const': 'error',
      // `== null` is deliberate: it is the null-or-undefined check used
      // throughout this codebase (and in react-native-background-downloader).
      eqeqeq: ['error', 'always', { null: 'ignore' }],

      // Import plugin rules
      'import/first': 'error',
      'import/no-duplicates': 'error',

      // Stylistic overrides (customize recommended)
      '@stylistic/semi': ['error', 'never'],
      '@stylistic/quotes': ['error', 'single', { allowTemplateLiterals: 'always' }],
      '@stylistic/indent': ['error', 2, { SwitchCase: 1 }],
      '@stylistic/max-len': ['error', { code: 120, ignoreTemplateLiterals: true }],
      '@stylistic/comma-dangle': [
        'error',
        {
          arrays: 'always-multiline',
          objects: 'always-multiline',
          imports: 'always-multiline',
          exports: 'never',
          functions: 'never',
        },
      ],
      '@stylistic/member-delimiter-style': [
        'error',
        {
          multiline: { delimiter: 'none', requireLast: false },
          singleline: { delimiter: 'semi', requireLast: false },
        },
      ],
    },
  },
  {
    files: ['src/specs/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-definitions': 'off',
    },
  },
  {
    // The Expo config plugin compiles separately (CommonJS, its own tsconfig),
    // so it needs its own project reference for type-aware linting.
    files: ['plugin/src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: './plugin/tsconfig.json',
      },
    },
    rules: {
      // The plugin is CommonJS and reads package.json via require().
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
]
