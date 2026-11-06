import { Router } from 'express';

export function mapRoutes({ networkMap, audit }) {
  const router = Router();

  router.get('/', (req, res) => res.json({ nodes: networkMap.listNodes(), links: networkMap.listLinks() }));

  router.get('/live', async (req, res) => res.json(await networkMap.live()));

  router.post('/nodes', (req, res) => {
    const node = networkMap.createNode(req.body ?? {});
    audit(req, 'map.node_create', node.name);
    res.status(201).json({ node });
  });

  router.patch('/nodes/:id', (req, res) => {
    const node = networkMap.updateNode(req.params.id, req.body ?? {});
    audit(req, 'map.node_update', node.name);
    res.json({ node });
  });

  // Not audited: dragging a box around changes nothing on the network.
  router.put('/nodes/:id/position', (req, res) => {
    networkMap.moveNode(req.params.id, req.body ?? {});
    res.json({ ok: true });
  });

  router.delete('/nodes/:id', (req, res) => {
    const node = networkMap.deleteNode(req.params.id);
    audit(req, 'map.node_delete', node.name);
    res.json({ ok: true });
  });

  router.post('/links', (req, res) => {
    const link = networkMap.createLink(req.body ?? {});
    audit(req, 'map.link_create', link.label || link.interface);
    res.status(201).json({ link });
  });

  router.patch('/links/:id', (req, res) => {
    const link = networkMap.updateLink(req.params.id, req.body ?? {});
    audit(req, 'map.link_update', link.label || link.interface);
    res.json({ link });
  });

  router.delete('/links/:id', (req, res) => {
    const link = networkMap.deleteLink(req.params.id);
    audit(req, 'map.link_delete', link.label || link.interface);
    res.json({ ok: true });
  });

  return router;
}
