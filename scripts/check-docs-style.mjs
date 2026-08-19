// Lints the TypeScript snippets inside README.md and docs/*.md with the
// project's own style rules.
//
// Documentation code is not compiled and not linted, so it drifts away from the
// house style - which then teaches readers the wrong conventions. This extracts
// every ```ts / ```tsx block and runs the subset of rules that make sense for a
// fragment: brace style, quotes, semicolons, indentation.
//
// Deliberately does NOT enable type-aware or no-undef rules - snippets
// reference things they never declare, and that is fine.
//
// Run with: yarn check:docs

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { Linter } from 'eslint'
import tsParser from '@typescript-eslint/parser'
import stylistic from '@stylistic/eslint-plugin'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/** Every markdown file that carries examples. */
function markdownFiles (dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...markdownFiles(full))
    else if (entry.endsWith('.md')) out.push(full)
  }
  return out
}

const FILES = [join(ROOT, 'README.md'), ...markdownFiles(join(ROOT, 'docs'))]

/** Fenced ```ts / ```tsx blocks, with the line they start on. */
function extractBlocks (source) {
  const blocks = []
  const lines = source.split('\n')
  let current = null

  lines.forEach((line, i) => {
    const open = /^```(ts|tsx|typescript)\s*$/.exec(line.trim())
    if (current == null && open != null) {
      current = { startLine: i + 2, code: [] }
      return
    }
    if (current != null && line.trim() === '```') {
      blocks.push({ ...current, code: current.code.join('\n') })
      current = null
      return
    }
    if (current != null) current.code.push(line)
  })

  return blocks
}

const linter = new Linter({ configType: 'flat' })

const config = {
  files: ['**/*.{ts,tsx}'],
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 'latest',
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
  plugins: { '@stylistic': stylistic },
  rules: {
    // The rule this script exists for: single-statement bodies take no braces.
    curly: ['error', 'multi', 'consistent'],
    '@stylistic/semi': ['error', 'never'],
    '@stylistic/quotes': ['error', 'single', { allowTemplateLiterals: 'always' }],
    '@stylistic/indent': ['error', 2, { SwitchCase: 1 }],
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
  },
}

let problems = 0

for (const file of FILES) {
  const source = readFileSync(file, 'utf8')

  for (const block of extractBlocks(source)) {
    let messages
    try {
      messages = linter.verify(block.code, config, 'snippet.tsx')
    } catch {
      // A fragment the parser cannot handle is not a style failure.
      continue
    }

    for (const m of messages) {
      // A config that matches nothing means the checker itself is broken - it
      // would otherwise report success while running no rules at all.
      if (m.message.includes('No matching configuration')) {
        console.error(`checker misconfigured: ${m.message}`)
        process.exit(2)
      }
      // Parse errors come from intentionally partial snippets; ignore them and
      // report only style violations.
      if (m.fatal || m.ruleId == null) continue
      problems += 1
      const line = block.startLine + m.line - 1
      console.error(`${relative(ROOT, file)}:${line}  ${m.message}  (${m.ruleId})`)
    }
  }
}

if (problems > 0) {
  console.error(`\ndocs style check FAILED: ${problems} problem(s)`)
  process.exit(1)
}

console.log(`docs style check passed (${FILES.length} files)`)
