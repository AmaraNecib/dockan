/**
 * Regression tests for the skills-mirror drift gate
 * (`scripts/sync-claude-skills.ts`). The gate exists so an absolute symlink
 * written by `npx skills add` cannot pass as a mirror copy; these tests pin
 * that a link at ANY depth — in either tree — fails `compare`, including a
 * linked `SKILL.md` whose content matches the source, the case a content-only
 * check misses.
 */
import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
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
  nonLockedAgentLinks,
  runCheck,
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

  it('flags a changed binary whose bytes decode to the same replacement characters', () => {
    withMirrorTrees((source, dest) => {
      // The locked `shadcn` skill ships PNGs. `0x89` and `0x88` are both
      // invalid UTF-8 and decode to U+FFFD, so comparing these as strings
      // reported no difference and a changed image passed the gate.
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      writeFileSync(join(source, 'logo.png'), png)
      writeFileSync(join(dest, 'logo.png'), png)
      expect(compare('demo', source, dest)).toEqual([])

      writeFileSync(join(dest, 'logo.png'), Buffer.concat([Buffer.from([0x88]), png.subarray(1)]))
      expect(compare('demo', source, dest)).toEqual([
        'demo/logo.png: content differs',
      ])
    })
  })

  it('still normalises CRLF for text and flags a binary against text', () => {
    withMirrorTrees((source, dest) => {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
      writeFileSync(join(source, 'logo.png'), png)
      writeFileSync(join(dest, 'logo.png'), png)
      // A Windows checkout of a text file must still compare equal.
      writeFileSync(join(dest, 'SKILL.md'), '# demo\r\n')
      expect(compare('demo', source, dest)).toEqual([])

      // Same path, one side bytes and the other text: not equal.
      writeFileSync(join(source, 'logo.png'), '# demo\n')
      expect(compare('demo', source, dest)).toEqual([
        'demo/logo.png: content differs',
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
      // A dangling link has no target to follow, so only the walked Dirent
      // sees it — the exact "breaks in another checkout" case.
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

/**
 * A real temp mirror root: one locked skill (`demo`) present in both trees, one
 * non-locked Pi-only skill (`guard`) in `.agents` only, and a one-entry
 * `skills-lock.json`. The callback receives the root; the temp dir is removed.
 */
const withTempRoot = (run: (root: string) => void) => {
  const root = mkdtempSync(join(tmpdir(), 'skills-check-root-'))
  try {
    mkdirSync(join(root, '.agents', 'skills', 'demo', 'rules'), {
      recursive: true,
    })
    mkdirSync(join(root, '.claude', 'skills', 'demo', 'rules'), {
      recursive: true,
    })
    writeFileSync(join(root, '.agents', 'skills', 'demo', 'SKILL.md'), '# demo\n')
    writeFileSync(join(root, '.claude', 'skills', 'demo', 'SKILL.md'), '# demo\n')
    mkdirSync(join(root, '.agents', 'skills', 'guard'), { recursive: true })
    writeFileSync(join(root, '.agents', 'skills', 'guard', 'SKILL.md'), '# guard\n')
    writeFileSync(
      join(root, 'skills-lock.json'),
      JSON.stringify({ version: 1, skills: { demo: { source: 'x', skillPath: 'y' } } }),
    )
    run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const SCRIPT = join(import.meta.dir, 'sync-claude-skills.ts')
const REPO_ROOT = join(import.meta.dir, '..')

/** Run the real CLI against `root`; pass `[]` to exercise `sync`. */
const runCli = (root: string, args: string[] = ['--check']) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, SKILLS_MIRROR_ROOT: root },
    encoding: 'utf8',
  })

describe('runCheck', () => {
  it('passes a root whose non-locked trees hold only real files', () => {
    withTempRoot((root) => {
      expect(runCheck(root)).toEqual({ names: ['demo'], problems: [] })
    })
  })

  it('reports a link inside a non-locked .agents tree', () => {
    withTempRoot((root) => {
      symlinkSync(
        join(root, '.agents', 'skills', 'demo', 'SKILL.md'),
        join(root, '.agents', 'skills', 'guard', 'linked.md'),
        'junction',
      )
      expect(runCheck(root).problems).toEqual([
        '.agents/skills/guard/linked.md is a symlink',
      ])
    })
  })

  it('reports a non-locked top-level tree that is itself a link', () => {
    withTempRoot((root) => {
      mkdirSync(join(root, '.agents', 'skills', 'pi-only'))
      writeFileSync(join(root, '.agents', 'skills', 'pi-only', 'SKILL.md'), '# pi\n')
      rmSync(join(root, '.agents', 'skills', 'pi-only'), {
        recursive: true,
        force: true,
      })
      symlinkSync(
        join(root, '.agents', 'skills', 'demo'),
        join(root, '.agents', 'skills', 'pi-only'),
        'junction',
      )
      expect(runCheck(root).problems).toEqual([
        '.agents/skills/pi-only is a symlink',
      ])
    })
  })
})

describe('nonLockedAgentLinks', () => {
  it('returns nothing when every non-locked entry is a real directory', () => {
    withTempRoot((root) => {
      expect(
        nonLockedAgentLinks(join(root, '.agents', 'skills'), ['demo']),
      ).toEqual([])
    })
  })

  it('returns nothing when the agents tree is absent', () => {
    expect(
      nonLockedAgentLinks(join(tmpdir(), 'skills-absent-tree'), ['demo']),
    ).toEqual([])
  })
})

describe('skills:check CLI (SKILLS_MIRROR_ROOT)', () => {
  it('reports the temp tree in sync and exits 0', () => {
    withTempRoot((root) => {
      const result = runCli(root)
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('in sync: 1 skills')
    })
  })

  it('fails closed on a link in a non-locked tree, with the link remedy', () => {
    withTempRoot((root) => {
      symlinkSync(
        join(root, '.agents', 'skills', 'demo', 'SKILL.md'),
        join(root, '.agents', 'skills', 'guard', 'linked.md'),
        'junction',
      )
      const result = runCli(root)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(
        '.agents/skills/guard/linked.md is a symlink',
      )
      expect(result.stderr).toContain('Replace every symlink')
    })
  })

  it('points plain drift at skills:sync, not the link remedy', () => {
    withTempRoot((root) => {
      writeFileSync(
        join(root, '.claude', 'skills', 'demo', 'SKILL.md'),
        '# changed\n',
      )
      const result = runCli(root)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Run `bun run skills:sync`')
      expect(result.stderr).not.toContain('Replace every symlink')
    })
  })

  it('fails closed, with one line, on a malformed skills-lock.json', () => {
    withTempRoot((root) => {
      writeFileSync(join(root, 'skills-lock.json'), '{ not json')
      const result = runCli(root)
      expect(result.status).toBe(1)
      expect(result.stderr.trim().split('\n')).toHaveLength(1)
      expect(result.stderr).toContain('skills mirror check failed')
    })
  })

  it('refuses to sync a source that holds a symlink and leaves the mirror', () => {
    withTempRoot((root) => {
      symlinkSync(
        join(root, '.agents', 'skills', 'demo', 'SKILL.md'),
        join(root, '.agents', 'skills', 'demo', 'rules', 'linked.md'),
        'junction',
      )
      const result = runCli(root, [])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('refusing to sync')
      expect(result.stderr).toContain('.agents/skills/demo/rules/linked.md')
      expect(
        readFileSync(join(root, '.claude', 'skills', 'demo', 'SKILL.md'), 'utf8'),
      ).toBe('# demo\n')
    })
  })
})

describe('skills:check CLI — hardening edges', () => {
  it('fails closed on a link inside a locked skill tree', () => {
    withTempRoot((root) => {
      symlinkSync(
        join(root, '.agents', 'skills', 'demo', 'SKILL.md'),
        join(root, '.agents', 'skills', 'demo', 'rules', 'linked.md'),
        'junction',
      )
      const result = runCli(root)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(
        '.agents/skills/demo/rules/linked.md is a symlink',
      )
    })
  })

  it('treats a dangling locked source link as a link, not a missing skill', () => {
    withTempRoot((root) => {
      const target = join(root, 'gone-target')
      rmSync(join(root, '.agents', 'skills', 'demo'), {
        recursive: true,
        force: true,
      })
      mkdirSync(target)
      symlinkSync(target, join(root, '.agents', 'skills', 'demo'), 'junction')
      rmSync(target, { recursive: true, force: true })

      const check = runCli(root)
      expect(check.status).toBe(1)
      expect(check.stderr).toContain('.agents/skills/demo is a symlink')
      expect(check.stderr).not.toContain('is missing')

      const sync = runCli(root, [])
      expect(sync.status).toBe(1)
      expect(sync.stderr).toContain('refusing to sync')
      expect(sync.stderr).toContain('.agents/skills/demo')
    })
  })

  it('reports a dangling .agents/skills root link without missing-source noise', () => {
    withTempRoot((root) => {
      const target = join(root, 'agents-target')
      rmSync(join(root, '.agents', 'skills'), { recursive: true, force: true })
      mkdirSync(target)
      symlinkSync(target, join(root, '.agents', 'skills'), 'junction')
      rmSync(target, { recursive: true, force: true })

      const result = runCli(root)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('.agents/skills is a symlink')
      expect(result.stderr).not.toContain('is missing')
    })
  })

  it('fails closed when skills-lock.json has no skills object', () => {
    withTempRoot((root) => {
      writeFileSync(join(root, 'skills-lock.json'), '{"version":1}')
      const result = runCli(root)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('no `skills` object')
    })
  })

  it('refuses every lock key that would escape the skills directory', () => {
    for (const name of ['..', '.', 'a/b', 'a\\b', 'C:x', '']) {
      withTempRoot((root) => {
        writeFileSync(
          join(root, 'skills-lock.json'),
          JSON.stringify({ skills: { [name]: {} } }),
        )
        const check = runCli(root)
        expect(check.status).toBe(1)
        expect(check.stderr).toContain('unsafe skill name')

        const sync = runCli(root, [])
        expect(sync.status).toBe(1)
        expect(sync.stderr).toContain('unsafe skill name')
        // The real mirror must survive the refusal.
        expect(
          readFileSync(join(root, '.claude', 'skills', 'demo', 'SKILL.md'), 'utf8'),
        ).toBe('# demo\n')
      })
    }
  })

  it('fails closed when skills is not a plain object', () => {
    for (const value of [[], 'abc', 42]) {
      withTempRoot((root) => {
        writeFileSync(
          join(root, 'skills-lock.json'),
          JSON.stringify({ skills: value }),
        )
        const result = runCli(root)
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('no `skills` object')
      })
    }
  })

  it('fails closed when the lock lists no skills', () => {
    withTempRoot((root) => {
      writeFileSync(join(root, 'skills-lock.json'), '{"skills":{}}')
      const result = runCli(root)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('lists no skills')
    })
  })

  it('reports an extra .claude/skills entry', () => {
    withTempRoot((root) => {
      mkdirSync(join(root, '.claude', 'skills', 'stray'), { recursive: true })
      writeFileSync(
        join(root, '.claude', 'skills', 'stray', 'SKILL.md'),
        '# stray\n',
      )
      const result = runCli(root)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(
        '.claude/skills/stray is not in skills-lock.json (extra)',
      )
    })
  })

  it('points a linked mirror at skills:sync, not at hand-editing', () => {
    withTempRoot((root) => {
      const target = join(root, 'surrogate')
      mkdirSync(target)
      writeFileSync(join(target, 'SKILL.md'), '# real\n')
      rmSync(join(root, '.claude', 'skills', 'demo'), {
        recursive: true,
        force: true,
      })
      symlinkSync(target, join(root, '.claude', 'skills', 'demo'), 'junction')

      const result = runCli(root)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('.claude/skills/demo is a symlink')
      expect(result.stderr).toContain('Run `bun run skills:sync`')
      expect(result.stderr).not.toContain('Replace every symlink')
    })
  })

  it('tells a linked .claude/skills root to replace it by hand, not to sync', () => {
    withTempRoot((root) => {
      const target = join(root, 'claude-target')
      mkdirSync(join(target, 'demo'), { recursive: true })
      writeFileSync(join(target, 'demo', 'SKILL.md'), '# demo\n')
      rmSync(join(root, '.claude', 'skills'), { recursive: true, force: true })
      symlinkSync(target, join(root, '.claude', 'skills'), 'junction')

      const result = runCli(root)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('.claude/skills is a symlink')
      expect(result.stderr).toContain('Replace every symlink')
      expect(result.stderr).not.toContain('to replace the linked mirror')

      // sync refuses the linked root too, so hand-replacement is the only fix.
      const sync = runCli(root, [])
      expect(sync.status).toBe(1)
      expect(sync.stderr).toContain('refusing to sync')
    })
  })

  it('syncs a clean temp root and exits 0', () => {
    withTempRoot((root) => {
      rmSync(join(root, '.claude', 'skills', 'demo'), {
        recursive: true,
        force: true,
      })
      const result = runCli(root, [])
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('synced 1 skill(s)')
      expect(
        readFileSync(join(root, '.claude', 'skills', 'demo', 'SKILL.md'), 'utf8'),
      ).toBe('# demo\n')
    })
  })

  it('sync fails cleanly on a malformed skills-lock.json', () => {
    withTempRoot((root) => {
      writeFileSync(join(root, 'skills-lock.json'), '{ not json')
      const result = runCli(root, [])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('skills mirror sync failed')
    })
  })

  it('fails closed on a link two levels into a non-locked tree', () => {
    withTempRoot((root) => {
      mkdirSync(join(root, '.agents', 'skills', 'guard', 'rules'), {
        recursive: true,
      })
      symlinkSync(
        join(root, '.agents', 'skills', 'demo', 'SKILL.md'),
        join(root, '.agents', 'skills', 'guard', 'rules', 'linked.md'),
        'junction',
      )
      const result = runCli(root)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(
        '.agents/skills/guard/rules/linked.md is a symlink',
      )
    })
  })

  it('drives the wired `bun run skills:check` against a temp root', () => {
    withTempRoot((root) => {
      symlinkSync(
        join(root, '.agents', 'skills', 'demo', 'SKILL.md'),
        join(root, '.agents', 'skills', 'guard', 'linked.md'),
        'junction',
      )
      const result = spawnSync(process.execPath, ['run', 'skills:check'], {
        cwd: REPO_ROOT,
        env: { ...process.env, SKILLS_MIRROR_ROOT: root },
        encoding: 'utf8',
      })
      expect(result.status).toBe(1)
      // A CLI that ignored the override would pass the real tree, so the link
      // path in the output proves the env var reached the wired command.
      expect(result.stderr + result.stdout).toContain(
        '.agents/skills/guard/linked.md is a symlink',
      )
    })
  })
})
