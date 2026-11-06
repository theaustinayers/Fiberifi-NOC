// Sub-users on a customer account. They share the account's subnets and act at one of two levels:
//   admin      edits records and rDNS, and manages the team
//   read_only  views and exports only
// The account owner is not a member, so no member can lock the owner out or take over their login.
import { generatePassword, hashPassword } from './lib/security.js';
import { ApiError, email as checkEmail, oneOf, requiredText } from './validate.js';

export const ACCESS_LEVELS = ['admin', 'read_only'];
const FIELDS = 'id, email, name, access, disabled, must_change_password, created_at, last_login_at';

export function createTeam(db) {
  function requireAccount(accountId) {
    const account = db
      .prepare(`SELECT ${FIELDS}, company FROM users WHERE id = ? AND role = 'customer' AND parent_id IS NULL`)
      .get(Number(accountId));
    if (!account) throw new ApiError(404, 'not_found', 'That customer account does not exist');
    return account;
  }

  // Scoped by account, so one customer can never reach another customer's members by id.
  function requireMember(accountId, id) {
    const member = db.prepare(`SELECT ${FIELDS} FROM users WHERE id = ? AND parent_id = ?`).get(Number(id), accountId);
    if (!member) throw new ApiError(404, 'not_found', 'That team member does not exist');
    return member;
  }

  function assertEmailFree(address, ignoreId = 0) {
    if (db.prepare('SELECT 1 FROM users WHERE email = ? AND id <> ?').get(address, ignoreId)) {
      throw new ApiError(409, 'duplicate', 'An account with that email already exists', { field: 'email' });
    }
  }

  function assertNotSelf(member, actorId, message) {
    if (member.id === actorId) throw new ApiError(409, 'self', message);
  }

  return {
    list(accountId) {
      return {
        owner: requireAccount(accountId),
        members: db.prepare(`SELECT ${FIELDS} FROM users WHERE parent_id = ? ORDER BY name`).all(accountId),
      };
    },

    async add(accountId, input) {
      requireAccount(accountId);
      const address = checkEmail(input.email);
      const name = requiredText(input.name, { max: 120, field: 'name', label: 'Name' });
      const access = oneOf(input.access ?? 'read_only', ACCESS_LEVELS, 'access');
      assertEmailFree(address);
      const temporaryPassword = generatePassword();
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO users (role, parent_id, access, email, name, password_hash, must_change_password)
           VALUES ('customer', ?, ?, ?, ?, ?, 1)`,
        )
        .run(accountId, access, address, name, await hashPassword(temporaryPassword));
      return { member: requireMember(accountId, Number(lastInsertRowid)), temporaryPassword };
    },

    update(accountId, id, input, actorId) {
      const member = requireMember(accountId, id);
      const name = input.name === undefined ? member.name : requiredText(input.name, { max: 120, field: 'name', label: 'Name' });
      const address = input.email === undefined ? member.email : checkEmail(input.email);
      const access = input.access === undefined ? member.access : oneOf(input.access, ACCESS_LEVELS, 'access');
      const disabled = input.disabled === undefined ? member.disabled : input.disabled ? 1 : 0;
      assertEmailFree(address, member.id);
      if (access !== member.access) assertNotSelf(member, actorId, 'You cannot change your own access level');
      if (disabled !== member.disabled) assertNotSelf(member, actorId, 'You cannot disable your own login');

      db.prepare('UPDATE users SET name = ?, email = ?, access = ?, disabled = ? WHERE id = ?').run(name, address, access, disabled, member.id);
      if (disabled && !member.disabled) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(member.id);
      return requireMember(accountId, member.id);
    },

    async resetPassword(accountId, id, actorId) {
      const member = requireMember(accountId, id);
      assertNotSelf(member, actorId, 'Use the Account page to change your own password');
      const temporaryPassword = generatePassword();
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(
        await hashPassword(temporaryPassword),
        member.id,
      );
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(member.id);
      return { member, temporaryPassword };
    },

    remove(accountId, id, actorId) {
      const member = requireMember(accountId, id);
      assertNotSelf(member, actorId, 'You cannot remove your own login');
      db.prepare('DELETE FROM users WHERE id = ?').run(member.id);
      return member;
    },
  };
}
