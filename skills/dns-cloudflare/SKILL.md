---
name: dns-cloudflare
description: >
  Operate Cloudflare DNS records and zone settings from the Cloudflare dashboard
  or API — add/edit/delete DNS records (A, AAAA, CNAME, TXT, MX), manage proxy
  status (orange cloud), check TTL and propagation, verify zone/name server
  status, and issue zone-scoped API tokens with least privilege. Use whenever a
  task involves Cloudflare DNS, domain verification TXT records, or checking
  whether a record is live. Contains critical gotchas: proxied records hide the
  origin IP, CNAME at zone apex is not allowed, and API tokens must be scoped per
  zone, never account-wide.
license: MIT
metadata:
  author: codingwisely
  version: "1.0.0"
---

## What I do
- Manage DNS records in a Cloudflare zone: A, AAAA, CNAME, TXT, MX, SRV
- Toggle proxy status (orange cloud = proxied, grey cloud = DNS only)
- Verify zone status and name server assignment
- Create zone-scoped API tokens (least privilege)

## When to use me
Use this skill whenever a task mentions Cloudflare, DNS records, domain
verification (e.g. DKIM/SPF/DMARC TXT records), or "is the domain live yet".

## How to operate

### Dashboard
- Login: https://dash.cloudflare.com — pick the account, then the zone (domain).
- Records live under the zone: **DNS -> Records**.
- The **proxy status** toggle per record:
  - Orange cloud: traffic flows through Cloudflare (origin IP hidden).
  - Grey cloud: DNS only (record points straight to the origin).
- **TTL**: normally "Auto". Only set explicit TTL when debugging.
- DNS changes apply fast (seconds to minutes) — no 24-48h wait unless the
  registrar's name servers were just switched.

### API tokens (least privilege)
- Dashboard -> **My Profile -> API Tokens -> Create Token**.
- Use "Edit zone DNS" template, scope it to the specific zone(s), never
  account-wide. Token permissions needed: **Zone.Zone:Read**, **Zone.DNS:Edit**.
- The token is secret — never commit it, never echo it in chat or logs.

### Verification TXT records
- Adding a TXT record (e.g. for email auth or domain verification):
  1. DNS -> Records -> Add record -> Type TXT
  2. Name = the subdomain (`_dmarc`, `_domainkey` etc.), Content = the value,
     TTL = Auto
  3. Confirm the record shows as "Proxied: DNS only" (TXT is never proxied)
- Check propagation with `dig TXT <name> @1.1.1.1` or via
  https://dash.cloudflare.com DNS -> DNS Analytics.

## Critical gotchas
- **CNAME at the zone apex is not allowed** by DNS standards. Use A/AAAA or
  Cloudflare's "CNAME flattening" (automatic).
- **Never expose an origin IP** by unproxying a record for a server that relies
  on Cloudflare protection — the IP becomes public immediately.
- **Deleting a record is irreversible** — confirm the exact record and value
  before deleting. Same for changing proxy status on a production record.
- If the zone shows "Pending nameserver update", DNS records exist but the
  domain will not resolve until the registrar points to Cloudflare name servers.
- A proxied record hides the origin, so `dig` shows Cloudflare IPs, not yours —
  that is expected, not a bug.

## Rules
- Confirm before any destructive action: delete record, disable proxy on a
  production record, change zone-level settings.
- Never invent DNS values — read the required value from the source (provider
  dashboard, docs, or the user) before creating a record.
- Report the final state: record type, name, value, proxy status, TTL.