import {
  bigint,
  index,
  int,
  mysqlTable,
  primaryKey,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core'

import { users } from './users'

/**
 * Role-based access control foundation (stage spec §15–§16).
 *
 * Roles and permissions are addressed by stable machine-readable codes
 * (e.g. role `ADMIN`, permission `account.self.read`); display names are
 * presentation only. Sensitive authorization must check permissions, not
 * role names. Assignment tables use composite primary keys and cascade
 * on delete deliberately: removing a user or role removes only the
 * assignment rows, never other entities.
 */
export const roles = mysqlTable(
  'roles',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    code: varchar('code', { length: 50 }).notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    description: varchar('description', { length: 255 }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [uniqueIndex('roles_code_unique').on(table.code)],
)

export const permissions = mysqlTable(
  'permissions',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    code: varchar('code', { length: 100 }).notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    description: varchar('description', { length: 255 }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [uniqueIndex('permissions_code_unique').on(table.code)],
)

export const userRoles = mysqlTable(
  'user_roles',
  {
    userId: bigint('user_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: int('role_id', { unsigned: true })
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    grantedAt: timestamp('granted_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.roleId] }),
    index('user_roles_role_id_idx').on(table.roleId),
  ],
)

export const rolePermissions = mysqlTable(
  'role_permissions',
  {
    roleId: int('role_id', { unsigned: true })
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionId: int('permission_id', { unsigned: true })
      .notNull()
      .references(() => permissions.id, { onDelete: 'cascade' }),
    grantedAt: timestamp('granted_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.roleId, table.permissionId] }),
    index('role_permissions_permission_id_idx').on(table.permissionId),
  ],
)
