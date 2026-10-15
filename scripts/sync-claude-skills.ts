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

/** The fields this script reads from one `skills-lock.json` entry. */
type LockedSkill = { source: string; skillPath: string }
type SkillsLock = { version: number; skills: Record<string, LockedSkill> }

/** Normalise CRLF so a Windows checkout compares equal to a Unix one. */
const readNormalised = (file: string) =>
  readFileSync(file, 'utf8').replace(/\r\n/g, '\n')

/** The `Dirent` fields the walk reads; a test supplies a fake for links. */
export type WalkEntry = {
  name: string
  isSymbolicLink(): boolean
  isDirectory(): boolean
}

/** `readdir` narrowed to what the walk consumes, so a test can inject entries. */
export type ReadDir = (dir: string) => WalkEntry[]

const readDirEntries: ReadDir = (dir) =>
  readdirSync(dir, { withFileTypes: true })

export type TreeWalk = { files: string[]; links: string[] }

/**
 * Every file below `dir`, as POSIX-style paths relative to `dir`, plus every
 * symlink found at ANY depth. A linked `SKILL.md` is as non-portable as a
 * linked skill directory (`npx skills add` writes absolute links outside the
 * repo), so the walk reports both instead of treating a link as a regular
 * file or recursing through it.
 */
export const walkTree = (
  dir: string,
  readdir: ReadDir = readDirEntries,
): TreeWalk => {
  const walk: TreeWalk = { files: [], links: [] }
  const visit = (current: string) => {
    for (const entry of readdir(current)) {
      const path = join(current, entry.name)
      const relativePath = relative(dir, path).split(sep).join('/')
      if (entry.isSymbolicLink()) walk.links.push(relativePath)
      else if (entry.isDirectory()) visit(path)
      else walk.files.push(relativePath)
    }
  }
  visit(dir)
  return { files: walk.files.sort(), links: walk.links.sort() }
}

const isSymlink = (path: string): boolean =>
  existsSync(path) && lstatSync(path).isSymbolicLink()

/** Problems that make `source` and `dest` non-equivalent, as human strings. */
export const compare = (
  name: string,
  source: string,
  dest: string,
  readdir: ReadDir = readDirEntries,
): string[] => {
  const problems: string[] = []
  if (isSymlink(source)) {
    problems.push(`.agents/skills/${name} is a symlink (mirror source)`)
    return problems
  }
  if (isSymlink(dest)) {
    problems.push(
      `.claude/skills/${name} is a symlink (npx skills add writes absolute links)`,
    )
    return problems
  }
  const sourceTree = walkTree(source, readdir)
  const destTree = walkTree(dest, readdir)
  for (const link of sourceTree.links)
    problems.push(`.agents/skills/${name}/${link} is a symlink`)
  for (const link of destTree.links)
    problems.push(`.claude/skills/${name}/${link} is a symlink`)
  const sourceLinks = new Set(sourceTree.links)
  const destLinks = new Set(destTree.links)
  const allFiles = [...new Set([...sourceTree.files, ...destTree.files])].sort()
  for (const file of allFiles) {
    // Presence comes from the walked names, not `existsSync`: a case-only
    // rename must fail here (the gate runs on Windows locally and on
    // case-sensitive Linux in CI), and `existsSync` follows a leaf link.
    const inSource = sourceTree.files.includes(file)
    const inDest = destTree.files.includes(file)
    // A link at this path is already reported above; reporting it again as
    // "missing" would describe the link as an absence instead of a link.
    if (!inSource) {
      if (!sourceLinks.has(file))
        problems.push(`.claude/skills/${name}/${file} has no source`)
    } else if (!inDest) {
      if (!destLinks.has(file))
        problems.push(`.agents/skills/${name}/${file} is missing from .claude`)
    } else if (
      readNormalised(join(source, file)) !== readNormalised(join(dest, file))
    )
      problems.push(`${name}/${file}: content differs`)
  }
  return problems
}

const main = () => {
  const checkOnly = process.argv.includes('--check')

  // SAFETY: skills-lock.json is a checked-in repo file with this schema; the
  // only field consumed here is the `skills` key set, and a malformed file
  // surfaces as a missing mirror source in the checks below.
  const lock = JSON.parse(readFileSync(LOCK_FILE, 'utf8')) as SkillsLock
  const names = Object.keys(lock.skills).sort()

  if (checkOnly) {
    const problems: string[] = []
    // The roots themselves are the one depth the per-skill walk cannot see.
    if (isSymlink(AGENTS_DIR))
      problems.push('.agents/skills is a symlink (mirror source)')
    if (isSymlink(CLAUDE_DIR))
      problems.push(
        '.claude/skills is a symlink (npx skills add writes absolute links)',
      )
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
      console.error(
        '\nRun `bun run skills:sync` to regenerate .claude from .agents.',
      )
      process.exit(1)
    }
    console.log(
      `skills mirror in sync: ${names.length} skills in .claude/skills == .agents/skills`,
    )
    process.exit(0)
  }

  // A linked root would make `dest` resolve back into the source tree, so a
  // sync could `rmSync` the source of truth before copying it.
  for (const root of [AGENTS_DIR, CLAUDE_DIR]) {
    if (isSymlink(root)) {
      console.error(
        `refusing to sync: ${relative(ROOT, root)} is a symlink (replace it with a real directory)`,
      )
      process.exit(1)
    }
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
}

if (import.meta.main) main()
