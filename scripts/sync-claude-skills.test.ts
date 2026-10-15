/**
 * Regression tests for the skills-mirror drift gate
 * (`scripts/sync-claude-skills.ts`). The gate exists so an absolute symlink
 * written by `npx skills add` cannot pass as a mirror copy; these tests pin
 * that a link at ANY depth fails `compare`, including a linked `SKILL.md`
 * whose content matches the source — the case a content-only check misses.
 */
import { describe, expect, it } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  compare,
  walkTree,
  type ReadDir,
  type WalkEntry,
} from './sync-claude-skills'

type FakeEntry = { name: string; link?: boolean; dir?: boolean }

/** A `readdir` over an in-memory tree, so a link needs no OS support. */
const fakeReadDir =
  (tree: Record<string, FakeEntry[]>): ReadDir =>
  (dir) => {
    const entries = tree[dir]
    if (entries === undefined) throw new Error(`no fake entries for ${dir}`)
    return entries.map(
      ({ name, link = false, dir: isDir = false }): WalkEntry => ({
        name,
        isSymbolicLink: () => link,
        isDirectory: () => isDir && !link,
      }),
    )
  }

/**
 * A real on-disk pair of mirror trees holding one identical `SKILL.md`. The
 * callback receives both roots; the temp dir is always removed.
 */
const withMirrorTrees = (run: (source: string, dest: string) => void) => {
  const root = mkdtempSync(join(tmpdir(), 'skills-mirror-'))
  try {
    const source = join(root, 'source')
    const dest = join(root, 'dest')
    mkdirSync(join(source, 'rules'), { recursive: true })
    mkdirSync(join(dest, 'rules'), { recursive: true })
    writeFileSync(join(source, 'SKILL.md'), '# demo\n')
    writeFileSync(join(dest, 'SKILL.md'), '# demo\n')
    run(source, dest)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('walkTree', () => {
  it('reports a link at any depth and never lists it as a file', () => {
    const skill = join(tmpdir(), 'fake-skill')
    const readdir = fakeReadDir({
      [skill]: [{ name: 'SKILL.md' }, { name: 'rules', dir: true }],
      [join(skill, 'rules')]: [
        { name: 'search-validation.md' },
        { name: 'linked.md', link: true },
      ],
    })

    expect(walkTree(skill, readdir)).toEqual({
      files: ['SKILL.md', 'rules/search-validation.md'],
      links: ['rules/linked.md'],
    })
  })
})

describe('compare', () => {
  it('passes two identical real trees', () => {
    withMirrorTrees((source, dest) => {
      expect(compare('demo', source, dest)).toEqual([])
    })
  })

  it('rejects a linked SKILL.md whose content matches', () => {
    withMirrorTrees((source, dest) => {
      // Fake only the OS's "this entry is a link" report: an absolute file
      // link to matching content is exactly what the old walk let through.
      const readdir: ReadDir = (dir) => {
        const entries = readdirSync(dir, { withFileTypes: true })
        if (dir !== dest) return entries
        return entries.map((entry): WalkEntry =>
          entry.name === 'SKILL.md'
            ? {
                name: entry.name,
                isSymbolicLink: () => true,
                isDirectory: () => false,
              }
            : entry,
        )
      }

      expect(compare('demo', source, dest, readdir)).toEqual([
        '.claude/skills/demo/SKILL.md is a symlink',
      ])
    })
  })

  it('rejects a nested linked file with no same-named source', () => {
    withMirrorTrees((source, dest) => {
      const readdir: ReadDir = (dir) => {
        const entries = readdirSync(dir, { withFileTypes: true })
        if (dir !== join(dest, 'rules')) return entries
        return [
          ...entries,
          {
            name: 'linked.md',
            isSymbolicLink: () => true,
            isDirectory: () => false,
          },
        ]
      }

      expect(compare('demo', source, dest, readdir)).toEqual([
        '.claude/skills/demo/rules/linked.md is a symlink',
      ])
    })
  })

  it('rejects a real nested directory link', () => {
    withMirrorTrees((source, dest) => {
      mkdirSync(join(source, 'rules', 'nested'))
      // 'junction' on Windows (no admin needed), an ordinary symlink on POSIX.
      symlinkSync(
        join(source, 'rules', 'nested'),
        join(dest, 'rules', 'linked'),
        'junction',
      )

      expect(compare('demo', source, dest)).toContain(
        '.claude/skills/demo/rules/linked is a symlink',
      )
    })
  })
})
