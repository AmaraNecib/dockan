/**
 * Regression tests for the skills-mirror drift gate
 * (`scripts/sync-claude-skills.ts`). The gate exists so an absolute symlink
 * written by `npx skills add` cannot pass as a mirror copy; these tests pin
 * that a link at ANY depth — in either tree — fails `compare`, including a
 * linked `SKILL.md` whose content matches the source, the case a content-only
 * check misses.
 */
import { describe, expect, it } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

const asLink = (name: string): WalkEntry => ({
  name,
  isSymbolicLink: () => true,
  isDirectory: () => false,
})

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

/** Real `readdir`, except one existing entry under `dir` reports as a link. */
const relinkEntry =
  (dir: string, name: string): ReadDir =>
  (target) => {
    const entries = readdirSync(target, { withFileTypes: true })
    if (target !== dir) return entries
    return entries.map((entry): WalkEntry =>
      entry.name === name ? asLink(entry.name) : entry,
    )
  }

/** Real `readdir`, plus a fake linked file called `name` under `dir`. */
const injectLink =
  (dir: string, name: string): ReadDir =>
  (target) => {
    const entries = readdirSync(target, { withFileTypes: true })
    if (target !== dir) return entries
    return [...entries, asLink(name)]
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

/**
 * A file symlink is the genuine `Dirent` case the linked-`SKILL.md` test
 * needs, and Windows without Developer Mode cannot create one (EPERM). Probe
 * once so that test SKIPS there instead of returning early — an early return
 * still reports `(pass)` with zero assertions, so the coverage row lies.
 */
const canSymlinkFiles = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-symlink-probe-'))
  try {
    const target = join(dir, 'target')
    writeFileSync(target, 'probe')
    symlinkSync(target, join(dir, 'link'), 'file')
    return true
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})()

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

  it('recurses past one directory level to find a link', () => {
    const skill = join(tmpdir(), 'fake-skill-deep')
    const readdir = fakeReadDir({
      [skill]: [{ name: 'rules', dir: true }],
      [join(skill, 'rules')]: [{ name: 'deep', dir: true }],
      [join(skill, 'rules', 'deep')]: [
        { name: 'ok.md' },
        { name: 'linked.md', link: true },
      ],
    })

    // The link sits two levels down, so a non-recursive walk would miss it.
    expect(walkTree(skill, readdir)).toEqual({
      files: ['rules/deep/ok.md'],
      links: ['rules/deep/linked.md'],
    })
  })
})

describe('compare', () => {
  it('passes two identical real trees', () => {
    withMirrorTrees((source, dest) => {
      expect(compare('demo', source, dest)).toEqual([])
    })
  })

  it('flags differing content', () => {
    withMirrorTrees((source, dest) => {
      writeFileSync(join(dest, 'SKILL.md'), '# changed\n')
      expect(compare('demo', source, dest)).toEqual([
        'demo/SKILL.md: content differs',
      ])
    })
  })

  it('flags a file that only the mirror has', () => {
    withMirrorTrees((source, dest) => {
      writeFileSync(join(dest, 'extra.md'), '# extra\n')
      expect(compare('demo', source, dest)).toEqual([
        '.claude/skills/demo/extra.md has no source',
      ])
    })
  })

  it('flags a file that only the source has', () => {
    withMirrorTrees((source, dest) => {
      writeFileSync(join(source, 'extra.md'), '# extra\n')
      expect(compare('demo', source, dest)).toEqual([
        '.agents/skills/demo/extra.md is missing from .claude',
      ])
    })
  })

  it('rejects a linked SKILL.md whose content matches', () => {
    withMirrorTrees((source, dest) => {
      // The premise of the test name; a fixture edit would otherwise turn it
      // into a lie while the assertion kept passing.
      expect(readFileSync(join(source, 'SKILL.md'), 'utf8')).toBe(
        readFileSync(join(dest, 'SKILL.md'), 'utf8'),
      )

      // Fake only the OS's "this entry is a link" report: an absolute file
      // link to matching content is exactly what the old walk let through.
      expect(
        compare('demo', source, dest, relinkEntry(dest, 'SKILL.md')),
      ).toEqual(['.claude/skills/demo/SKILL.md is a symlink'])
    })
  })

  it.skipIf(!canSymlinkFiles)(
    'rejects a real linked SKILL.md with matching content',
    () => {
      withMirrorTrees((source, dest) => {
        rmSync(join(dest, 'SKILL.md'))
        symlinkSync(join(source, 'SKILL.md'), join(dest, 'SKILL.md'), 'file')

        expect(compare('demo', source, dest)).toEqual([
          '.claude/skills/demo/SKILL.md is a symlink',
        ])
      })
    },
  )

  it('rejects a nested linked file with no same-named source', () => {
    withMirrorTrees((source, dest) => {
      expect(
        compare('demo', source, dest, injectLink(join(dest, 'rules'), 'linked.md')),
      ).toEqual(['.claude/skills/demo/rules/linked.md is a symlink'])
    })
  })

  it('rejects a linked file inside the source tree', () => {
    withMirrorTrees((source, dest) => {
      // `dest` holds a real file at the same path, so only the source link can
      // explain the failure.
      writeFileSync(join(dest, 'linked.md'), '# demo\n')

      expect(
        compare('demo', source, dest, injectLink(source, 'linked.md')),
      ).toEqual(['.agents/skills/demo/linked.md is a symlink'])
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

      // Exact, not `toContain`: a regression that also lists a link as a file
      // must fail this test rather than sneak a sibling problem past it.
      expect(compare('demo', source, dest)).toEqual([
        '.claude/skills/demo/rules/linked is a symlink',
      ])
    })
  })

  it('rejects a dangling nested link', () => {
    withMirrorTrees((source, dest) => {
      // `isSymlink` uses existsSync, so only the walked Dirent can see a link
      // whose target is gone — the exact "breaks in another checkout" case.
      symlinkSync(
        join(source, 'rules', 'missing'),
        join(dest, 'rules', 'dangling'),
        'junction',
      )

      expect(compare('demo', source, dest)).toEqual([
        '.claude/skills/demo/rules/dangling is a symlink',
      ])
    })
  })

  it('rejects a linked skill directory root on either side', () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-root-'))
    try {
      const source = join(root, 'source')
      mkdirSync(source)
      writeFileSync(join(source, 'SKILL.md'), '# demo\n')

      const destLinked = join(root, 'dest-linked')
      symlinkSync(source, destLinked, 'junction')
      expect(compare('demo', source, destLinked)).toEqual([
        '.claude/skills/demo is a symlink (npx skills add writes absolute links)',
      ])

      const sourceLinked = join(root, 'source-linked')
      symlinkSync(source, sourceLinked, 'junction')
      expect(compare('demo', sourceLinked, source)).toEqual([
        '.agents/skills/demo is a symlink (mirror source)',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
