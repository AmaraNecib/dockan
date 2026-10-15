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
 * `--check` walks the mirrored set file by file, and separately walks every
 * non-mirrored `.agents/skills` tree for symlinks: a committed link breaks
 * another checkout whether or not Claude Code consumes that skill. `sync`
 * refuses a source that holds a link, because `cpSync` would copy the link.
 *
 * Usage:
 *   bun scripts/sync-claude-skills.ts          # regenerate .claude from .agents
 *   bun scripts/sync-claude-skills.ts --check  # exit 1 on any drift
 *
 * `SKILLS_MIRROR_ROOT` points either mode at another tree (a test fixture).
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

/** The repo root the CLI acts on; a test points it at a temp tree. */
const resolveRoot = (): string => {
  const override = process.env.SKILLS_MIRROR_ROOT?.trim()
  return override !== undefined && override.length > 0
    ? resolve(override)
    : resolve(import.meta.dir, '..')
}

const paths = (root: string) => ({
  agentsDir: join(root, '.agents', 'skills'),
  claudeDir: join(root, '.claude', 'skills'),
  lockFile: join(root, 'skills-lock.json'),
})

/** The fields this script reads from one `skills-lock.json` entry. */
type LockedSkill = { source: string; skillPath: string }
type SkillsLock = { version: number; skills: Record<string, LockedSkill> }

/**
 * A text file with CRLF normalised so a Windows checkout compares equal to a
 * Unix one — or the raw bytes when the file is not valid UTF-8.
 *
 * Decoding a binary as a string is lossy: the locked `shadcn` skill ships PNGs,
 * and `0x89` and `0x88` both decode to U+FFFD, so a changed image compared
 * equal and passed the gate. Only a lossless UTF-8 round-trip is text.
 */
const readNormalised = (file: string): string | Buffer => {
  const bytes = readFileSync(file)
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) return bytes
  return text.replace(/\r\n/g, '\n')
}

/** Byte equality for binaries, string equality for normalised text. */
const sameContent = (a: string | Buffer, b: string | Buffer): boolean => {
  if (Buffer.isBuffer(a) !== Buffer.isBuffer(b)) return false
  if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) return a.equals(b)
  return a === b
}

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

const isSymlink = (path: string): boolean => {
  // `lstat` sees the link itself, so a dangling link still reports as one;
  // `existsSync` follows it and would call the path missing instead.
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

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
      !sameContent(
        readNormalised(join(source, file)),
        readNormalised(join(dest, file)),
      )
    )
      problems.push(`${name}/${file}: content differs`)
  }
  return problems
}

/**
 * A lock key becomes a path segment under the skills roots, so refuse a name
 * that escapes the directory: a separator, a drive/stream colon, `.` or `..`.
 */
const isSafeSkillName = (name: string): boolean =>
  name.length > 0 &&
  name !== '.' &&
  name !== '..' &&
  !name.includes('/') &&
  !name.includes('\\') &&
  !name.includes(':')

const readLock = (lockFile: string): SkillsLock => {
  // SAFETY: skills-lock.json is a checked-in repo file with this schema, so the
  // `as SkillsLock` cast holds. A malformed file cannot pass: a bad parse
  // throws before this line, a missing `skills` object throws below, and a key
  // that would escape the skills directory throws before any file operation.
  const lock = JSON.parse(readFileSync(lockFile, 'utf8')) as SkillsLock
  const skills = lock?.skills
  if (
    skills === null ||
    skills === undefined ||
    // JSON.parse yields plain objects, so an array, string, or number here is
    // a schema mistake, not a skills map; without this `{}`/`{"a":1}` could
    // pass vacuously (0 names, 0 mirror entries) and turn the gate off.
    Object.getPrototypeOf(skills) !== Object.prototype
  )
    throw new Error('skills-lock.json has no `skills` object')
  if (Object.keys(skills).length === 0)
    throw new Error('skills-lock.json lists no skills (the gate would be vacuous)')
  const unsafe = Object.keys(skills).filter((name) => !isSafeSkillName(name))
  if (unsafe.length > 0)
    throw new Error(
      `skills-lock.json has unsafe skill name(s): ${unsafe.join(', ')}`,
    )
  return lock
}

/** Every non-locked `.agents/skills` entry that is (or holds) a symlink. */
export const nonLockedAgentLinks = (
  agentsDir: string,
  names: string[],
): string[] => {
  if (!existsSync(agentsDir) || isSymlink(agentsDir)) return []
  const locked = new Set(names)
  const problems: string[] = []
  for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
    if (locked.has(entry.name)) continue
    const path = join(agentsDir, entry.name)
    if (entry.isSymbolicLink()) {
      problems.push(`.agents/skills/${entry.name} is a symlink`)
    } else if (entry.isDirectory()) {
      for (const link of walkTree(path).links)
        problems.push(`.agents/skills/${entry.name}/${link} is a symlink`)
    }
  }
  return problems
}

export type CheckResult = { names: string[]; problems: string[] }

/**
 * Check `root`'s mirror and report every problem. Locked skills are compared
 * file by file; every other `.agents/skills` entry is still walked for
 * symlinks, because a committed link breaks another checkout even when the
 * skill is Pi-only.
 */
export const runCheck = (root: string): CheckResult => {
  const { agentsDir, claudeDir, lockFile } = paths(root)
  const names = Object.keys(readLock(lockFile).skills).sort()
  const problems: string[] = []
  // The roots themselves are the one depth the per-skill walk cannot see.
  if (isSymlink(agentsDir))
    problems.push('.agents/skills is a symlink (mirror source)')
  if (isSymlink(claudeDir))
    problems.push(
      '.claude/skills is a symlink (npx skills add writes absolute links)',
    )
  // A linked root already fails the gate; comparing through it would only add
  // noise (every source "missing", or the mirror resolving to the source).
  if (problems.length === 0) {
    if (!existsSync(claudeDir)) {
      problems.push('.claude/skills does not exist')
    } else {
      for (const name of names) {
        const source = join(agentsDir, name)
        const dest = join(claudeDir, name)
        // An `existsSync` guard first would call a dangling link "missing";
        // `compare` sees a link via `lstat` and owns the link messages.
        if (isSymlink(source) || isSymlink(dest)) {
          problems.push(...compare(name, source, dest))
          continue
        }
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
      for (const entry of readdirSync(claudeDir, { withFileTypes: true })) {
        if (!names.includes(entry.name))
          problems.push(
            `.claude/skills/${entry.name} is not in skills-lock.json (extra)`,
          )
      }
    }
  }
  problems.push(...nonLockedAgentLinks(agentsDir, names))
  return { names, problems }
}

const main = () => {
  const checkOnly = process.argv.includes('--check')
  const root = resolveRoot()
  const { agentsDir, claudeDir, lockFile } = paths(root)

  if (checkOnly) {
    let result: CheckResult
    try {
      result = runCheck(root)
    } catch (error) {
      console.error(
        `skills mirror check failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      process.exit(1)
    }

    if (result.problems.length > 0) {
      console.error(`skills mirror drift: ${result.problems.length} problem(s)`)
      for (const problem of result.problems) console.error(`  - ${problem}`)
      // A source link can only be fixed by hand (sync refuses it). A linked
      // mirror is regenerated by sync, so send each class to its real remedy.
      const sourceLink = result.problems.some(
        (problem) =>
          problem.startsWith('.agents/skills') && problem.includes('is a symlink'),
      )
      const mirrorLink = result.problems.some(
        (problem) =>
          problem.startsWith('.claude/skills') && problem.includes('is a symlink'),
      )
      if (sourceLink)
        console.error(
          '\nReplace every symlink above with a real file, then re-run `bun run skills:check`.',
        )
      else if (mirrorLink)
        console.error(
          '\nRun `bun run skills:sync` to replace the linked mirror.',
        )
      else
        console.error(
          '\nRun `bun run skills:sync` to regenerate .claude from .agents.',
        )
      process.exit(1)
    }
    console.log(
      `skills mirror in sync: ${result.names.length} skills in .claude/skills == .agents/skills`,
    )
    process.exit(0)
  }

  // A linked root would make `dest` resolve back into the source tree, so a
  // sync could `rmSync` the source of truth before copying it.
  for (const dir of [agentsDir, claudeDir]) {
    if (isSymlink(dir)) {
      console.error(
        `refusing to sync: ${relative(root, dir).split(sep).join('/')} is a symlink (replace it with a real directory)`,
      )
      process.exit(1)
    }
  }

  let names: string[]
  try {
    names = Object.keys(readLock(lockFile).skills).sort()
  } catch (error) {
    console.error(
      `skills mirror sync failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exit(1)
  }

  // `cpSync` copies a link as a link, which would recreate the very drift the
  // check rejects. Refuse before touching the mirror.
  const sourceLinks: string[] = []
  for (const name of names) {
    const source = join(agentsDir, name)
    if (isSymlink(source)) {
      sourceLinks.push(`.agents/skills/${name}`)
    } else if (existsSync(source)) {
      for (const link of walkTree(source).links)
        sourceLinks.push(`.agents/skills/${name}/${link}`)
    }
  }
  if (sourceLinks.length > 0) {
    console.error('refusing to sync: the mirror source contains symlink(s):')
    for (const link of sourceLinks) console.error(`  - ${link}`)
    console.error(
      '\nReplace each with a real file, then re-run `bun run skills:sync`.',
    )
    process.exit(1)
  }

  mkdirSync(claudeDir, { recursive: true })
  let synced = 0
  const missing: string[] = []
  for (const name of names) {
    const source = join(agentsDir, name)
    const dest = join(claudeDir, name)
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
  for (const entry of readdirSync(claudeDir, { withFileTypes: true })) {
    if (!known.has(entry.name)) {
      rmSync(join(claudeDir, entry.name), { recursive: true, force: true })
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
