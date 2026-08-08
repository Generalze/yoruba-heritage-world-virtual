import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/mysql2/migrator'

import { closeDb, getDb } from '@/db'
import {
  auditLogs,
  deities,
  roles,
  sacredHouses,
  services,
  users,
} from '@/db/schema'
import { seedRbac } from '@/db/seed'
import { seedDomain } from '@/db/seed-domain'
import { ForbiddenError } from '@/auth/guards'
import { assignRoleToUser, getUserPermissionCodes } from '@/auth/rbac'
import { registerUser } from '@/auth/service'
import {
  WorkflowError,
  addFocusArea,
  addMember,
  createDeity,
  createSacredHouse,
  createService,
  deityWorkflow,
  sacredHouseWorkflow,
  serviceWorkflow,
  setDeityHouseLink,
  updateDeity,
  updateFocusArea,
  updateMember,
  updateSacredHouse,
} from '@/services/admin-catalogue'
import {
  getPublishedDeityBySlug,
  listPublishedDeities,
} from '@/services/catalogue'
import type { RoleCode } from '@/auth/rbac'

/**
 * Step 3.5 access + workflow matrix against the local Docker MariaDB.
 * Fixture users get random credentials and are removed afterwards;
 * temporary catalogue records are cleaned up in FK-safe order.
 */

const ctx = { ipAddress: null, userAgent: 'bun-test' }
const PASSPHRASE = `admin test passphrase ${crypto.randomUUID()}`
const createdUserIds: Array<number> = []
const tempDeityIds: Array<number> = []
const tempHouseIds: Array<number> = []
const tempServiceIds: Array<number> = []

let plainUser: number
let contentManager: number
let admin: number
let superAdmin: number

async function makeUser(role: RoleCode | null): Promise<number> {
  const result = await registerUser(
    {
      email: `s35-${crypto.randomUUID()}@test.local`,
      preferredName: 'Step35 Fixture',
      password: PASSPHRASE,
    },
    ctx,
  )
  if (!result.ok) throw new Error(`fixture failed: ${result.error}`)
  createdUserIds.push(result.user.id)
  if (role && role !== 'USER') await assignRoleToUser(result.user.id, role)
  return result.user.id
}

let fixtureCounter = 0
function uid(): string {
  fixtureCounter += 1
  return `${fixtureCounter}${crypto.randomUUID().slice(0, 6).replace(/-/g, 'x')}`.toUpperCase()
}

async function makeDraftDeity(actorId: number): Promise<number> {
  const key = uid()
  const id = await createDeity(actorId, ctx, {
    code: `T35_${key}`,
    name: `T35 Deity ${key}`,
    slug: `t35-${key.toLowerCase()}`,
  })
  tempDeityIds.push(id)
  return id
}

async function deityRow(id: number) {
  return (
    await getDb().select().from(deities).where(eq(deities.id, id)).limit(1)
  ).at(0)!
}

async function houseRow(id: number) {
  return (
    await getDb()
      .select()
      .from(sacredHouses)
      .where(eq(sacredHouses.id, id))
      .limit(1)
  ).at(0)!
}

async function expectForbidden(action: () => Promise<unknown>) {
  let thrown: unknown = null
  try {
    await action()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(ForbiddenError)
}

async function expectWorkflowError(action: () => Promise<unknown>) {
  let thrown: unknown = null
  try {
    await action()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(WorkflowError)
}

beforeAll(async () => {
  await migrate(getDb(), { migrationsFolder: './migrations' })
  await seedRbac()
  await seedDomain()
  plainUser = await makeUser('USER')
  contentManager = await makeUser('CONTENT_MANAGER')
  admin = await makeUser('ADMIN')
  superAdmin = await makeUser('SUPER_ADMIN')
})

afterAll(async () => {
  const db = getDb()
  if (tempServiceIds.length > 0) {
    await db.delete(services).where(inArray(services.id, tempServiceIds))
  }
  if (tempHouseIds.length > 0) {
    await db.delete(sacredHouses).where(inArray(sacredHouses.id, tempHouseIds))
  }
  if (tempDeityIds.length > 0) {
    await db.delete(deities).where(inArray(deities.id, tempDeityIds))
  }
  if (createdUserIds.length > 0) {
    await db
      .delete(auditLogs)
      .where(inArray(auditLogs.actorUserId, createdUserIds))
    await db.delete(users).where(inArray(users.id, createdUserIds))
  }
  await closeDb()
})

describe('RBAC model (corrected)', () => {
  it('a fresh seed contains no CULTURAL_REVIEWER role', async () => {
    const rows = await getDb()
      .select({ code: roles.code })
      .from(roles)
      .where(eq(roles.code, 'CULTURAL_REVIEWER'))
    expect(rows.length).toBe(0)
  })

  it('catalogue.approve and catalogue.publish belong to ADMIN and SUPER_ADMIN only', async () => {
    const adminPerms = await getUserPermissionCodes(admin)
    const superPerms = await getUserPermissionCodes(superAdmin)
    const cmPerms = await getUserPermissionCodes(contentManager)
    const userPerms = await getUserPermissionCodes(plainUser)

    for (const perms of [adminPerms, superPerms]) {
      expect(perms).toContain('catalogue.approve')
      expect(perms).toContain('catalogue.publish')
    }
    for (const perms of [cmPerms, userPerms]) {
      expect(perms).not.toContain('catalogue.approve')
      expect(perms).not.toContain('catalogue.publish')
    }
    // CONTENT_MANAGER keeps authoring permissions.
    expect(cmPerms).toContain('deities.manage')
    expect(cmPerms).toContain('sacred_houses.manage')
    expect(cmPerms).toContain('services.manage')
  })
})

describe('access control', () => {
  it('USER cannot use catalogue mutations', async () => {
    await expectForbidden(() =>
      createDeity(plainUser, ctx, {
        code: 'T35_USERDENY',
        name: 'Deny',
        slug: 't35-userdeny',
      }),
    )
    const id = await makeDraftDeity(contentManager)
    await expectForbidden(() => updateDeity(plainUser, ctx, id, { name: 'X' }))
    await expectForbidden(() => deityWorkflow(plainUser, ctx, id, 'submit'))
  })

  it('CONTENT_MANAGER can create, edit DRAFT and submit — but not approve/publish/unpublish', async () => {
    const id = await makeDraftDeity(contentManager)
    expect((await deityRow(id)).profileStatus).toBe('DRAFT')

    await updateDeity(contentManager, ctx, id, { name: 'T35 Edited Draft' })
    expect((await deityRow(id)).name).toBe('T35 Edited Draft')

    await deityWorkflow(contentManager, ctx, id, 'submit')
    expect((await deityRow(id)).profileStatus).toBe('UNDER_REVIEW')

    await expectForbidden(() =>
      deityWorkflow(contentManager, ctx, id, 'approve'),
    )
    await expectForbidden(() =>
      deityWorkflow(contentManager, ctx, id, 'reject', 'nope'),
    )

    await deityWorkflow(admin, ctx, id, 'approve')
    await expectForbidden(() =>
      deityWorkflow(contentManager, ctx, id, 'publish'),
    )
    await deityWorkflow(admin, ctx, id, 'publish')
    await expectForbidden(() =>
      deityWorkflow(contentManager, ctx, id, 'unpublish'),
    )
  })

  it('SUPER_ADMIN inherits ADMIN catalogue authority but no bypass exists', async () => {
    const id = await makeDraftDeity(contentManager)
    // Even SUPER_ADMIN cannot publish a DRAFT.
    await expectWorkflowError(() =>
      deityWorkflow(superAdmin, ctx, id, 'publish'),
    )
    await deityWorkflow(contentManager, ctx, id, 'submit')
    await expectWorkflowError(() =>
      deityWorkflow(superAdmin, ctx, id, 'publish'),
    )
    await deityWorkflow(superAdmin, ctx, id, 'approve')
    await deityWorkflow(superAdmin, ctx, id, 'publish')
    expect((await deityRow(id)).profileStatus).toBe('PUBLISHED')
  })
})

describe('workflow', () => {
  it('rejection requires a note; rejection returns to DRAFT and resubmission clears the note', async () => {
    const id = await makeDraftDeity(contentManager)
    await deityWorkflow(contentManager, ctx, id, 'submit')

    await expectWorkflowError(() => deityWorkflow(admin, ctx, id, 'reject'))
    await expectWorkflowError(() =>
      deityWorkflow(admin, ctx, id, 'reject', '   '),
    )

    await deityWorkflow(admin, ctx, id, 'reject', 'Name spelling must match')
    let row = await deityRow(id)
    expect(row.profileStatus).toBe('DRAFT')
    expect(row.reviewNote).toBe('Name spelling must match')

    // Content Manager corrects and resubmits; feedback is cleared.
    await updateDeity(contentManager, ctx, id, { name: 'T35 Corrected' })
    await deityWorkflow(contentManager, ctx, id, 'submit')
    row = await deityRow(id)
    expect(row.profileStatus).toBe('UNDER_REVIEW')
    expect(row.reviewNote).toBeNull()
  })

  it('approval records approved_by and approved_at', async () => {
    const id = await makeDraftDeity(contentManager)
    await deityWorkflow(contentManager, ctx, id, 'submit')
    await deityWorkflow(admin, ctx, id, 'approve')
    const row = await deityRow(id)
    expect(row.profileStatus).toBe('APPROVED')
    expect(row.approvedBy).toBe(admin)
    expect(row.approvedAt).not.toBeNull()
  })

  it('unpublish returns to APPROVED with approval intact', async () => {
    const id = await makeDraftDeity(contentManager)
    await deityWorkflow(contentManager, ctx, id, 'submit')
    await deityWorkflow(admin, ctx, id, 'approve')
    await deityWorkflow(admin, ctx, id, 'publish')
    await deityWorkflow(admin, ctx, id, 'unpublish')
    const row = await deityRow(id)
    expect(row.profileStatus).toBe('APPROVED')
    expect(row.approvedBy).toBe(admin)
  })

  it('substantive edit of an APPROVED record reverts to DRAFT and clears approval — even for ADMIN', async () => {
    const id = await makeDraftDeity(contentManager)
    await deityWorkflow(contentManager, ctx, id, 'submit')
    await deityWorkflow(admin, ctx, id, 'approve')

    await updateDeity(admin, ctx, id, { name: 'T35 Changed After Approval' })
    const row = await deityRow(id)
    expect(row.profileStatus).toBe('DRAFT')
    expect(row.approvedBy).toBeNull()
    expect(row.approvedAt).toBeNull()
  })

  it('operational fields on APPROVED records are ADMIN-only; CM is denied', async () => {
    const id = await makeDraftDeity(contentManager)
    await deityWorkflow(contentManager, ctx, id, 'submit')
    await deityWorkflow(admin, ctx, id, 'approve')

    // CONTENT_MANAGER cannot adjust operational fields while APPROVED…
    await expectForbidden(() =>
      updateDeity(contentManager, ctx, id, { sortOrder: 555 }),
    )
    let row = await deityRow(id)
    expect(row.profileStatus).toBe('APPROVED')

    // …ADMIN can, and the approval survives an operational-only change.
    await updateDeity(admin, ctx, id, { sortOrder: 555 })
    row = await deityRow(id)
    expect(row.profileStatus).toBe('APPROVED')
    expect(row.approvedBy).toBe(admin)
    expect(row.sortOrder).toBe(555)
  })

  it('CM MAY edit substantive content on APPROVED — but the save atomically strips the approval', async () => {
    const id = await makeDraftDeity(contentManager)
    await deityWorkflow(contentManager, ctx, id, 'submit')
    await deityWorkflow(admin, ctx, id, 'approve')

    await updateDeity(contentManager, ctx, id, {
      name: 'T35 CM Edit After Approval',
      sortOrder: 777, // operational change rides along with the demotion
    })
    const row = await deityRow(id)
    expect(row.name).toBe('T35 CM Edit After Approval')
    expect(row.sortOrder).toBe(777)
    expect(row.profileStatus).toBe('DRAFT')
    expect(row.approvedBy).toBeNull()
    expect(row.approvedAt).toBeNull()
  })

  it('PUBLISHED substantive edits are blocked; archive/restore work', async () => {
    const id = await makeDraftDeity(contentManager)
    await deityWorkflow(contentManager, ctx, id, 'submit')
    await deityWorkflow(admin, ctx, id, 'approve')
    await deityWorkflow(admin, ctx, id, 'publish')

    await expectWorkflowError(() =>
      updateDeity(admin, ctx, id, { name: 'Sneaky Change' }),
    )

    await deityWorkflow(admin, ctx, id, 'archive')
    expect((await deityRow(id)).profileStatus).toBe('ARCHIVED')
    await expectWorkflowError(() =>
      updateDeity(admin, ctx, id, { name: 'Nope' }),
    )
    await deityWorkflow(admin, ctx, id, 'restore')
    const restored = await deityRow(id)
    expect(restored.profileStatus).toBe('DRAFT')
    expect(restored.approvedBy).toBeNull()
  })
})

describe('Sacred House subcontent (focus areas, members)', () => {
  async function makeApprovedHouse(): Promise<number> {
    const key = uid()
    const id = await createSacredHouse(contentManager, ctx, {
      code: `T35H_${key}`,
      name: `T35 House ${key}`,
      slug: `t35h-${key.toLowerCase()}`,
    })
    tempHouseIds.push(id)
    await sacredHouseWorkflow(contentManager, ctx, id, 'submit')
    await sacredHouseWorkflow(admin, ctx, id, 'approve')
    return id
  }

  it('modifying focus areas on an APPROVED House invalidates the approval', async () => {
    const id = await makeApprovedHouse()
    await addFocusArea(contentManager, ctx, id, 'Approved focus wording')
    const row = await houseRow(id)
    expect(row.status).toBe('DRAFT')
    expect(row.approvedBy).toBeNull()
  })

  it('modifying focus areas or members on a PUBLISHED House is blocked', async () => {
    const id = await makeApprovedHouse()
    await sacredHouseWorkflow(admin, ctx, id, 'publish')

    await expectWorkflowError(() =>
      addFocusArea(contentManager, ctx, id, 'Blocked focus'),
    )
    await expectWorkflowError(() =>
      addMember(contentManager, ctx, id, {
        displayName: 'Blocked Member',
        memberType: 'PRAYER_WARRIOR',
      }),
    )
    expect((await houseRow(id)).status).toBe('PUBLISHED')
  })

  it('modifying a member on an APPROVED House invalidates the approval', async () => {
    const id = await makeApprovedHouse()
    const memberId = await (async () => {
      // Add while DRAFT-able: house is APPROVED so this demotes; that is
      // the expected behavior being verified.
      return addMember(contentManager, ctx, id, {
        displayName: 'T35 Member',
        memberType: 'PRAYER_WARRIOR',
      })
    })()
    let row = await houseRow(id)
    expect(row.status).toBe('DRAFT')

    // Re-approve, then edit the member: approval invalidates again.
    await sacredHouseWorkflow(contentManager, ctx, id, 'submit')
    await sacredHouseWorkflow(admin, ctx, id, 'approve')
    await updateMember(contentManager, ctx, memberId, { active: false })
    row = await houseRow(id)
    expect(row.status).toBe('DRAFT')
    expect(row.approvedBy).toBeNull()
  })

  it('focus-area edits demote an APPROVED House via updateFocusArea too', async () => {
    const id = await makeApprovedHouse()
    // House is APPROVED; adding demotes to DRAFT.
    const focusId = await addFocusArea(contentManager, ctx, id, 'Wording v1')
    await sacredHouseWorkflow(contentManager, ctx, id, 'submit')
    await sacredHouseWorkflow(admin, ctx, id, 'approve')
    await updateFocusArea(contentManager, ctx, focusId, { active: false })
    expect((await houseRow(id)).status).toBe('DRAFT')
  })
})

describe('deity relationships', () => {
  it('changing relationships on an APPROVED deity invalidates approval; on PUBLISHED it is blocked', async () => {
    const deityId = await makeDraftDeity(contentManager)
    const houseKey = uid()
    const houseId = await createSacredHouse(contentManager, ctx, {
      code: `T35H_${houseKey}`,
      name: `T35 RelHouse ${houseKey}`,
      slug: `t35h-${houseKey.toLowerCase()}`,
    })
    tempHouseIds.push(houseId)

    // Linking while DRAFT is fine.
    await setDeityHouseLink(contentManager, ctx, deityId, houseId, true)
    expect((await deityRow(deityId)).profileStatus).toBe('DRAFT')

    await deityWorkflow(contentManager, ctx, deityId, 'submit')
    await deityWorkflow(admin, ctx, deityId, 'approve')

    // APPROVED: relationship change demotes and clears approval.
    await setDeityHouseLink(contentManager, ctx, deityId, houseId, false)
    const row = await deityRow(deityId)
    expect(row.profileStatus).toBe('DRAFT')
    expect(row.approvedBy).toBeNull()

    // PUBLISHED: relationship change is blocked entirely.
    await deityWorkflow(contentManager, ctx, deityId, 'submit')
    await deityWorkflow(admin, ctx, deityId, 'approve')
    await deityWorkflow(admin, ctx, deityId, 'publish')
    await expectWorkflowError(() =>
      setDeityHouseLink(contentManager, ctx, deityId, houseId, true),
    )
    expect((await deityRow(deityId)).profileStatus).toBe('PUBLISHED')
  })
})

describe('audit trail', () => {
  it('workflow transitions create audit entries with safe metadata', async () => {
    const id = await makeDraftDeity(contentManager)
    await deityWorkflow(contentManager, ctx, id, 'submit')
    await deityWorkflow(admin, ctx, id, 'reject', 'Fix the slug please')
    await deityWorkflow(contentManager, ctx, id, 'submit')
    await deityWorkflow(admin, ctx, id, 'approve')
    await deityWorkflow(admin, ctx, id, 'publish')

    const rows = await getDb()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityId, String(id)))
    const actions = rows.map((row) => row.action)
    expect(actions).toContain('deity.created')
    expect(actions).toContain('deity.submitted_for_review')
    expect(actions).toContain('deity.returned_to_draft')
    expect(actions).toContain('deity.approved')
    expect(actions).toContain('deity.published')

    const rejection = rows.find(
      (row) => row.action === 'deity.returned_to_draft',
    )!
    const metadata = JSON.stringify(rejection.metadataJson)
    expect(metadata).toContain('Fix the slug please')
    expect(metadata).toContain('UNDER_REVIEW')
    expect(metadata.toLowerCase()).not.toContain('passphrase')
    expect(metadata.toLowerCase()).not.toContain(PASSPHRASE.toLowerCase())
  })
})

describe('publication safety', () => {
  it('non-published workflow states never appear in the public catalogue', async () => {
    const id = await makeDraftDeity(contentManager)
    const slug = (await deityRow(id)).slug

    expect(await getPublishedDeityBySlug(slug)).toBeNull() // DRAFT
    await deityWorkflow(contentManager, ctx, id, 'submit')
    expect(await getPublishedDeityBySlug(slug)).toBeNull() // UNDER_REVIEW
    await deityWorkflow(admin, ctx, id, 'approve')
    expect(await getPublishedDeityBySlug(slug)).toBeNull() // APPROVED

    await deityWorkflow(admin, ctx, id, 'publish')
    expect((await getPublishedDeityBySlug(slug))?.slug).toBe(slug)

    await deityWorkflow(admin, ctx, id, 'archive')
    expect(await getPublishedDeityBySlug(slug)).toBeNull() // ARCHIVED

    // Records that completed the full workflow legitimately appear.
    const publicSlugs = (await listPublishedDeities()).map((d) => d.slug)
    expect(publicSlugs).not.toContain(slug)
  })

  it('service workflow keeps hidden-House filtering intact end to end', async () => {
    const houseKey = uid()
    const houseId = await createSacredHouse(contentManager, ctx, {
      code: `T35H_${houseKey}`,
      name: `T35 SvcHouse ${houseKey}`,
      slug: `t35h-${houseKey.toLowerCase()}`,
    })
    tempHouseIds.push(houseId)
    const svcKey = uid()
    const serviceId = await createService(contentManager, ctx, {
      sacredHouseId: houseId,
      code: `T35S_${svcKey}`,
      name: `T35 Service ${svcKey}`,
      slug: `t35s-${svcKey.toLowerCase()}`,
    })
    tempServiceIds.push(serviceId)

    // Publish the service through the workflow while its House stays DRAFT.
    await serviceWorkflow(contentManager, ctx, serviceId, 'submit')
    await serviceWorkflow(admin, ctx, serviceId, 'approve')
    await serviceWorkflow(admin, ctx, serviceId, 'publish')

    const { getPublishedServiceBySlug } = await import('@/services/catalogue')
    expect(
      await getPublishedServiceBySlug(`t35s-${svcKey.toLowerCase()}`),
    ).toBeNull()

    // Publishing the House exposes the service.
    await sacredHouseWorkflow(contentManager, ctx, houseId, 'submit')
    await sacredHouseWorkflow(admin, ctx, houseId, 'approve')
    await sacredHouseWorkflow(admin, ctx, houseId, 'publish')
    expect(
      (await getPublishedServiceBySlug(`t35s-${svcKey.toLowerCase()}`))?.name,
    ).toBe(`T35 Service ${svcKey}`)
  })

  it('house update on PUBLISHED requires publish authority even for operational fields', async () => {
    const houseKey = uid()
    const houseId = await createSacredHouse(contentManager, ctx, {
      code: `T35H_${houseKey}`,
      name: `T35 OpHouse ${houseKey}`,
      slug: `t35h-${houseKey.toLowerCase()}`,
    })
    tempHouseIds.push(houseId)
    await sacredHouseWorkflow(contentManager, ctx, houseId, 'submit')
    await sacredHouseWorkflow(admin, ctx, houseId, 'approve')
    await sacredHouseWorkflow(admin, ctx, houseId, 'publish')

    // CM cannot touch a published record even operationally…
    await expectForbidden(() =>
      updateSacredHouse(contentManager, ctx, houseId, { sortOrder: 900 }),
    )
    // …ADMIN can adjust operational order without a status change.
    await updateSacredHouse(admin, ctx, houseId, { sortOrder: 901 })
    const row = await houseRow(houseId)
    expect(row.status).toBe('PUBLISHED')
    expect(row.sortOrder).toBe(901)
  })
})
