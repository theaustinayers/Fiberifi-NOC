# Fiberifi NOC panel

The network operations panel for `noc.fiberifi.com`: IPAM for Fiberifi's address space, and a customer portal for assigned subnets and reverse DNS.

Node.js 24, Express and SQLite (built into Node). There is no build step and no native dependency.

## Install on Ubuntu 26.04

Tested on a clean Ubuntu 26.04.1 LTS system.

**1. Point DNS at the server.** Create `A` and `AAAA` records for `noc.fiberifi.com`, and make sure ports 80 and 443 are reachable. The TLS certificate is issued automatically once this is done.

**2. Download and install on the server.**

```sh
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/theaustinayers/Fiberifi-NOC.git
cd Fiberifi-NOC
sudo bash deploy/install.sh
```

It installs Node.js 24 and Caddy, creates a locked-down `noc` service account, and starts everything. At the end it prints the first admin password, once. To use different values:

```sh
sudo DOMAIN=noc.fiberifi.com ADMIN_EMAIL=you@fiberifi.com bash deploy/install.sh
```

**3. Sign in, set a new password, and connect Cloudflare** (next section).

## Connect Cloudflare

Customers' rDNS changes are written to your reverse zones through the Cloudflare API.

1. In Cloudflare, add a zone for each reverse range you want to manage:

   | Range | Zone |
   |---|---|
   | `149.112.89.0/24` | `89.112.149.in-addr.arpa` |
   | `206.168.244.0/22` | `244.168.206.in-addr.arpa`, `245.…`, `246.…`, `247.…` (four zones) |
   | `2607:9340::/32` | `0.4.3.9.7.0.6.2.ip6.arpa` |
   | `2001:504:13a::/48` | `a.3.1.0.4.0.5.0.1.0.0.2.ip6.arpa` |

   The parent registry (ARIN) must delegate each zone to Cloudflare's nameservers, or the records will exist but nobody will see them.

2. Create an API token with **Zone: Read** and **DNS: Edit** on those zones.
3. In the panel, open **Settings**, paste the token and save.
4. Choose **Test connection** to see which zones were found.
5. Choose **Sync PTR records** to import any PTR records that already exist.

The token is encrypted in the database and never sent back to the browser.

## How it behaves

- **Reserved addresses.** Every prefix automatically has a network address, a gateway on the first usable address, and a broadcast on the last. Network and broadcast are blocked for everyone, in the API as well as the UI. Admins can edit the gateway's row and move it from the prefix's Edit dialog, and customers see it locked. IPv6 has no broadcast.
- **Which prefix decides.** When prefixes nest, the smallest one decides what an address is, so a `/22`'s gateway can't take a usable address from a `/31` inside it. Anything nested inside a customer's subnet is a label and reserves nothing.
- **Drilling down.** The Prefixes page opens any range into smaller blocks, down to single addresses, and refreshes every 15 seconds. Blocks don't need to exist as prefixes. **Use block** turns one into a real prefix and can assign it.
- **Internal space.** Choose **Internal (Fiberifi)** instead of a customer for space you use yourselves. **Release** removes the mark and keeps its records and PTRs.
- **Choosing a subnet.** Allocate takes the next free block of the length you pick, or the exact subnet you type, such as `206.168.244.240/29`. The **Allocate** button on a free-space row fills in that block.
- **Whole prefixes.** Allocating a prefix at its own size, such as `/22` from a `/22`, uses the whole prefix instead of subdividing it.
- **Nesting.** Prefixes can sit inside each other, and the smallest assignment wins: a customer can have a block inside an Internal range, and everything around it stays yours. An address can only belong to one customer, and a customer can't be given a block that contains a smaller Internal one. A prefix nested inside a customer's subnet is a label only, and doesn't reserve any of their addresses.
- **PTR records.** Customers can only publish them on usable addresses. Admins can also publish one on a gateway. Nobody can on a network or broadcast address, though admins can clear one that a sync imported.
- **Deleting a customer account** removes every PTR the account or its team created from Cloudflare. If any removal fails, the account is kept so nothing is left behind, and you can try again. Removing a single team member keeps their PTRs on the account.
- **`/31`, `/127` and `/32`.** Point-to-point subnets have no network or broadcast address. A single address has no gateway.
- **IPv6.** There is no broadcast, and the first address is treated as the network address. Because these subnets are enormous, only addresses with records are listed. Use **Add address** to create one.
- **Unassigning a subnet** removes the customer's access first, then deletes their address records and PTRs so the next customer inherits nothing. If Cloudflare is unreachable, the access is still removed and the admin is told which PTRs are left over. They can be cleared from the prefix's Addresses tab.
- **Assignments cannot overlap.** A subnet cannot be assigned if a parent or child of it is already assigned.
- **Default ranges** are seeded once. A deleted range stays deleted.
- **Team members.** A customer's owner login and any team member with Admin access can add logins to the account from the Team page. Admin members can edit records and rDNS and manage the team. Read-only members can view and export. Disabling or deleting a customer also cuts off its team.
- **Datacenters.** Managed under Datacenters in the menu. Allocating a subnet requires one, and VLAN is optional. A datacenter cannot be deleted while prefixes use it.

## Operations

| Task | Command |
|---|---|
| Upgrade | `git pull`, then `sudo bash deploy/install.sh` from the same folder. Data and settings are kept, and the database is backed up to `/var/lib/noc-fiberifi/backups/` first. |
| Logs | `journalctl -u noc-fiberifi -f` |
| Restart | `sudo systemctl restart noc-fiberifi` |
| Locked out of admin | `sudo noc-reset-admin admin@fiberifi.com` |

**Back up both of these:**

- `/var/lib/noc-fiberifi/` holds the database.
- `/etc/noc-fiberifi.env` holds `APP_SECRET`. Without it, the Cloudflare token cannot be decrypted and must be entered again.

For a consistent copy while the panel is running, stop the service first or use `sqlite3 noc.db ".backup backup.db"`.

## Development

```sh
npm install
npm run dev    # http://localhost:3100, prints the first admin password
npm test
```

The tests run against a mock Cloudflare API in `test/mock-cloudflare.js`. Set `CLOUDFLARE_API_BASE` to point the app at a different API endpoint.
