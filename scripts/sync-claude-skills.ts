#!/usr/bin/env bun
/**
 * Mirror the canonical agent skills into the Claude Code skills directory.
 *
 *   Source of truth : `.agents/skills/<name>`
 *   Mirrored set    : the keys of `skills-lock.json` (the skills installed by
 *                     `npx skills add`), which is exactly what `.claude/skills`
 *                     is expected to hold. Pi-only skills are deliberately not
 *                     mirrored — Claude Code does not consume them.
 *   Destination     : `.claude/skills/<name>` (real files, tracked in git)
 *
 * Why a copy + drift check instead of a symlink:
 *   1. `npx skills add` writes `.claude/skills/<name>` as an ABSOLUTE symlink
 *      into the installing worktree, so every other checkout gets a dangling
 *      link (and the link points outside the repo).
 *   2. This repo runs on Windows, where git symlinks need `core.symlinks` and
 *      are unreliable across checkouts.
 * A checked-in script that writes real files, plus `--check` wired into the
 * pre-commit hook and CI, is portable and fails loudly on divergence instead
 * of silently shipping a stale mirror.
 *
 * Usage:
 *   bun scripts/sync-claude-skills.ts          # regenerate .claude from .agents
 *   bun scripts/sync-claude-skills.ts --check  # exit 1 on any drift
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const AGENTS_DIR = join(ROOT, '.agents', 'skills')
const CLAUDE_DIR = join(ROOT, '.claude', 'skills')
const LOCK_FILE = join(ROOT, 'skills-lock.json')

const checkOnly = process.argv.includes('--check')

/** The fields this script reads from one `skills-lock.json` entry. */
type LockedSkill = { source: string; skillPath: string }
type SkillsLock = { version: number; skills: Record<string, LockedSkill> }

// SAFETY: skills-lock.json is a checked-in repo file with this schema; the only
// field consumed here is the `skills` key set, and a malformed file surfaces as
// a missing mirror source in the checks below.
const lock = JSON.parse(readFileSync(LOCK_FILE, 'utf8')) as SkillsLock
const names = Object.keys(lock.skills).sort()

/** Normalise CRLF so a Windows checkout compares equal to a Unix one. */
const readNormalised = (file: string) =>
  readFileSync(file, 'utf8').replace(/\r\n/g, '\n')

/** Every file below `dir`, as POSIX-style paths relative to `dir`. */
const listFiles = (dir: string): string[] => {
  const files: string[] = []
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else files.push(relative(dir, path).split(sep).join('/'))
    }
  }
  walk(dir)
  return files.sort()
}

const isSymlink = (path: string) =>
  existsSync(path) && lstatSync(path).isSymbolicLink()

/** Problems that make `source` and `dest` non-equivalent, as human strings. */
const compare = (name: string, source: string, dest: string): string[] => {
  const problems: string[] = []
  if (isSymlink(dest)) {
    problems.push(
      `.claude/skills/${name} is a symlink (npx skills add writes absolute links)`,
    )
    return problems
  }
  const sourceFiles = listFiles(source)
  const destFiles = listFiles(dest)
  const allFiles = [...new Set([...sourceFiles, ...destFiles])].sort()
  for (const file of allFiles) {
    const inSource = existsSync(join(source, file))
    const inDest = existsSync(join(dest, file))
    if (!inSource) problems.push(`.claude/skills/${name}/${file} has no source`)
    else if (!inDest)
      problems.push(`.agents/skills/${name}/${file} is missing from .claude`)
    else if (
      readNormalised(join(source, file)) !== readNormalised(join(dest, file))
    )
      problems.push(`${name}/${file}: content differs`)
  }
  return problems
}

if (checkOnly) {
  const problems: string[] = []
  if (!existsSync(CLAUDE_DIR)) {
    problems.push('.claude/skills does not exist')
  } else {
    for (const name of names) {
      const source = join(AGENTS_DIR, name)
      const dest = join(CLAUDE_DIR, name)
      if (!existsSync(source)) {
        problems.push(`.agents/skills/${name} is missing (mirror source)`)
        continue
      }
      if (!existsSync(dest)) {
        problems.push(`.claude/skills/${name} is missing`)
        continue
      }
      problems.push(...compare(name, source, dest))
    }
    for (const entry of readdirSync(CLAUDE_DIR, { withFileTypes: true })) {
      if (!names.includes(entry.name))
        problems.push(
          `.claude/skills/${entry.name} is not in skills-lock.json (extra)`,
        )
    }
  }

  if (problems.length > 0) {
    console.error(`skills mirror drift: ${problems.length} problem(s)`)
    for (const problem of problems) console.error(`  - ${problem}`)
    console.error('\nRun `bun run skills:sync` to regenerate .claude from .agents.')
    process.exit(1)
  }
  console.log(
    `skills mirror in sync: ${names.length} skills in .claude/skills == .agents/skills`,
  )
  process.exit(0)
}

mkdirSync(CLAUDE_DIR, { recursive: true })
let synced = 0
const missing: string[] = []
for (const name of names) {
  const source = join(AGENTS_DIR, name)
  const dest = join(CLAUDE_DIR, name)
  if (!existsSync(source)) {
    missing.push(name)
    continue
  }
  rmSync(dest, { recursive: true, force: true })
  cpSync(source, dest, { recursive: true })
  synced++
}

const known = new Set(names)
let pruned = 0
for (const entry of readdirSync(CLAUDE_DIR, { withFileTypes: true })) {
  if (!known.has(entry.name)) {
    rmSync(join(CLAUDE_DIR, entry.name), { recursive: true, force: true })
    pruned++
  }
}

console.log(`synced ${synced} skill(s) .agents -> .claude`)
if (pruned > 0) console.log(`pruned ${pruned} extra .claude/skills entr(ies)`)
if (missing.length > 0) {
  console.error(
    `missing .agents source for: ${missing.join(', ')} (add it, then re-run)`,
  )
  process.exit(1)
}
