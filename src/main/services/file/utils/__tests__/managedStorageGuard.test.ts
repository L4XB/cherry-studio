import type * as FsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@application', async () => {
  const { mockApplicationFactory } = await import('@test-mocks/main/application')
  return mockApplicationFactory()
})

// Paths whose `realpath` reports EISDIR. POSIX never produces that code here
// (it answers ENOENT / ENOTDIR), so the Windows behaviour has to be injected.
const eisdirPaths = new Set<string>()

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    realpath: async (target: Parameters<typeof actual.realpath>[0]) => {
      if (eisdirPaths.has(String(target))) {
        throw Object.assign(new Error(`EISDIR: illegal operation on a directory, realpath '${target}'`), {
          code: 'EISDIR'
        })
      }
      return actual.realpath(target)
    }
  }
})

const { application } = await import('@application')
const { assertOutsideManagedStorageMutation } = await import('../managedStorageGuard')

describe('assertOutsideManagedStorageMutation', () => {
  let root: string
  let managedRoot: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'cherry-managed-storage-guard-'))
    managedRoot = path.join(root, 'Data', 'Files')
    await mkdir(managedRoot, { recursive: true })
    vi.spyOn(application, 'getPath').mockImplementation((key: string) => {
      if (key === 'feature.files.data') return managedRoot
      throw new Error(`Unexpected application.getPath(${key})`)
    })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    eisdirPaths.clear()
    await rm(root, { recursive: true, force: true })
  })

  it('rejects the managed root, descendants, and ancestor directories', async () => {
    await expect(assertOutsideManagedStorageMutation(managedRoot)).rejects.toThrow(/overlaps FileManager-owned/)
    await expect(assertOutsideManagedStorageMutation(path.join(managedRoot, 'entry.bin'))).rejects.toThrow(
      /overlaps FileManager-owned/
    )
    await expect(assertOutsideManagedStorageMutation(path.dirname(managedRoot))).rejects.toThrow(
      /overlaps FileManager-owned/
    )
  })

  it('rejects either side of a move when one path overlaps managed storage', async () => {
    const outside = path.join(root, 'Notes', 'note.md')
    await expect(assertOutsideManagedStorageMutation(outside, path.join(managedRoot, 'entry.md'))).rejects.toThrow(
      /overlaps FileManager-owned/
    )
    await expect(assertOutsideManagedStorageMutation(path.join(managedRoot, 'entry.md'), outside)).rejects.toThrow(
      /overlaps FileManager-owned/
    )
  })

  it('rejects an existing symlink and a not-yet-created child that resolve into managed storage', async () => {
    const outside = path.join(root, 'outside')
    await mkdir(outside)
    const link = path.join(outside, 'managed-link')
    await symlink(managedRoot, link, process.platform === 'win32' ? 'junction' : 'dir')

    await expect(assertOutsideManagedStorageMutation(link)).rejects.toThrow(/overlaps FileManager-owned/)
    await expect(assertOutsideManagedStorageMutation(path.join(link, 'future.bin'))).rejects.toThrow(
      /overlaps FileManager-owned/
    )
  })

  it('allows a not-yet-created file whose realpath reports EISDIR instead of ENOENT', async () => {
    // A screenshot paste writes a temp file that does not exist yet. On a
    // redirected Windows volume that probe answers EISDIR, which the walk read
    // as fatal and failed the write before any bytes were written (#20572).
    const tempDir = path.join(root, 'Temp')
    await mkdir(tempDir)
    const screenshot = path.join(tempDir, 'screenshot-1757930000.png')
    eisdirPaths.add(screenshot)

    await expect(assertOutsideManagedStorageMutation(screenshot)).resolves.toBeUndefined()
  })

  it('still blocks an aliased not-yet-created path when the leaf reports EISDIR', async () => {
    // The walk must continue past the unresolvable leaf to the junction, not
    // give up and accept the lexical path: the alias is what makes this unsafe.
    const outside = path.join(root, 'outside')
    await mkdir(outside)
    const link = path.join(outside, 'managed-link')
    await symlink(managedRoot, link, process.platform === 'win32' ? 'junction' : 'dir')
    const aliased = path.join(link, 'screenshot-1757930001.png')
    eisdirPaths.add(aliased)

    await expect(assertOutsideManagedStorageMutation(aliased)).rejects.toThrow(/overlaps FileManager-owned/)
  })

  it('still blocks managed storage lexically when an existing ancestor reports EISDIR', async () => {
    // Skipping an ancestor that exists loses its symlink resolution, so the
    // lexical half of the check is what remains — it must still hold.
    eisdirPaths.add(managedRoot)

    await expect(assertOutsideManagedStorageMutation(path.join(managedRoot, 'entry.bin'))).rejects.toThrow(
      /overlaps FileManager-owned/
    )
  })

  it('allows ordinary Notes, Agent workspace, and export targets', async () => {
    const notes = path.join(root, 'Notes')
    const workspace = path.join(root, 'AgentWorkspace')
    const exportDir = path.join(root, 'Exports')
    await Promise.all([mkdir(notes), mkdir(workspace), mkdir(exportDir)])
    await writeFile(path.join(notes, 'existing.md'), 'note')

    await expect(
      assertOutsideManagedStorageMutation(
        path.join(notes, 'existing.md'),
        path.join(workspace, 'future.md'),
        path.join(exportDir, 'result.pdf')
      )
    ).resolves.toBeUndefined()
  })
})
