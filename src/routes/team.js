// The customer-facing team API. Fiberifi admins manage members through /api/admin/users instead.
import { Router } from 'express';
import { accountIdOf, canManageTeam } from '../ipam.js';
import { ApiError } from '../validate.js';

export function teamRoutes({ team, audit }) {
  const router = Router();

  router.use((req, res, next) => {
    if (!canManageTeam(req.user)) throw new ApiError(403, 'forbidden', 'Only account admins can manage the team');
    req.accountId = accountIdOf(req.user);
    next();
  });

  router.get('/', (req, res) => res.json(team.list(req.accountId)));

  router.post('/', async (req, res) => {
    const { member, temporaryPassword } = await team.add(req.accountId, req.body ?? {});
    audit(req, 'team.add', member.email, member.access);
    res.status(201).json({ member, temporaryPassword });
  });

  router.patch('/:id', (req, res) => {
    const member = team.update(req.accountId, req.params.id, req.body ?? {}, req.user.id);
    audit(req, 'team.update', member.email, { access: member.access, disabled: Boolean(member.disabled) });
    res.json({ member });
  });

  router.post('/:id/reset-password', async (req, res) => {
    const { member, temporaryPassword } = await team.resetPassword(req.accountId, req.params.id, req.user.id);
    audit(req, 'team.reset_password', member.email);
    res.json({ temporaryPassword });
  });

  router.delete('/:id', (req, res) => {
    const member = team.remove(req.accountId, req.params.id, req.user.id);
    audit(req, 'team.remove', member.email);
    res.json({ ok: true });
  });

  return router;
}
