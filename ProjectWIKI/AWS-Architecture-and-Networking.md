# AWS Architecture and Networking

## Environment Snapshot

- Date captured: `2026-03-24`
- AWS account: `130799455554`
- Region: `us-west-2`
- VPC: `vpc-023b623efc9fbe017` (`10.153.32.0/22`, `dev-vpc`)
- App EC2: `i-063e708d036f989f3` (`10.153.33.70`, no public IP)

## High-Level Architecture

```text
Users
  |
  | HTTPS 443 / HTTP 80
  v
Route53: chatvsp.vsp-app-aws-us-west-2.com
  |
  v
ALB (chatvspv1-alb, internet-facing)
  |  TG: chatvspv1-alb-tg-80 (HTTP:80, /api/health)
  v
EC2 ChatVSPv1 (private subnet, no public IP)
  |
  +-- nginx -> web_server (Next.js)
  +-- nginx -> api_server (FastAPI)
  +-- postgres/redis/vespa/opensearch/model/background containers

Admins
  |
  | TCP 22
  v
Route53: ssh-chatvsp.vsp-app-aws-us-west-2.com
  |
  v
NLB (chatvspv1-nlb, internet-facing)
  |  TG: chatvspv1-tg-22
  v
EC2 ChatVSPv1:22
```

## DNS and TLS

Hosted zone: `Z02793762ZIMB2CMEZ8N8` (`vsp-app-aws-us-west-2.com`)

- `chatvsp.vsp-app-aws-us-west-2.com` -> ALB alias
- `ssh-chatvsp.vsp-app-aws-us-west-2.com` -> NLB alias

ACM certs on ALB 443 listener:

- `chatvsp.vsp-app-aws-us-west-2.com` (`ISSUED`, SNI attached, non-default)
- `vsp-app-aws-us-west-2-dev.com` (`ISSUED`, default cert)

ALB TLS policy: `ELBSecurityPolicy-TLS13-1-2-2021-06`

## Subnet Layout

Private subnets:

- `subnet-03c3fb8249c47783e` (`10.153.32.0/24`, us-west-2a)
- `subnet-09c0e55d0b01d1f41` (`10.153.33.0/24`, us-west-2b) <- app VM
- `subnet-09048c8f8a9c501e1` (`10.153.34.0/24`, us-west-2c)

Public LB subnets:

- `subnet-03979c984a8adb8ce` (`10.153.35.0/26`, us-west-2a)
- `subnet-019a112128050211a` (`10.153.35.64/26`, us-west-2b)
- `subnet-090ffb22a21c55444` (`10.153.35.128/26`, us-west-2c)

## Routing and Private Networking

### Public route table (`rtb-00fa32604c8aed9b7`)

- `0.0.0.0/0 -> igw-02f9b3f65cbcd9ad7`
- associated with public LB subnets

### Private route table (`rtb-066f524147b3cbc69`)

- default and broad internal routes target ENI `eni-0248c97326202a77c`
- ENI belongs to `aviatrix-gicaistudiononprod-dev-uswest2-gw` (`i-0a61ab996365d5d15`)
- S3 gateway endpoint route present: `vpce-02536bde46eb60025`

Interpretation:

- app VM is in private subnet with no public IP
- egress path is controlled through Aviatrix gateway route targets
- S3 path also available via VPC endpoint route table entry

## Security Controls In Place

### EC2 instance hardening posture

- no public IPv4 assigned
- IMDSv2 required (`HttpTokens=required`)
- source/destination check enabled
- instance profile: none attached

### Security groups

App SG `sg-077b3092da89cc821`:

- inbound `80` from ALB SG only
- inbound `443` from ALB SG only
- inbound `22` from:
  - `38.158.148.0/24` (developer allowlist)
  - `10.153.35.0/26`, `10.153.35.64/26`, `10.153.35.128/26` (NLB health path ranges)
- outbound all (`0.0.0.0/0`)

ALB SG `sg-06aeab78a5a3bd85d`:

- inbound `80/443` from `0.0.0.0/0`
- outbound all

### NACLs

- default NACL `acl-0faf829c2ed29d2cd` across all subnets
- allow-all in/out with deny-all catch-all rule

### Storage

- root volume `vol-006ca0bc908dff22e` (`gp3`, 80GB)
- encryption: `false` (not encrypted)

### WAF

- ALB WAF association query returns `null` (no WAF web ACL attached)

## Health and Availability Settings

- ALB target group `chatvspv1-alb-tg-80`:
  - protocol/port: `HTTP:80`
  - health check path: `/api/health`
  - matcher: `200-399`
- NLB target group `chatvspv1-tg-22`:
  - protocol/port: `TCP:22`

## What Makes This VM Safer Today

- Private-subnet workload with no direct public IP
- Layered entry points (ALB for app, NLB for SSH)
- ALB-to-instance SG pinning for app ports
- SSH CIDR allowlist (not fully open internet)
- IMDSv2 enforced

## Gaps and Hardening Backlog

1. Encrypt EBS root volume.
2. Attach IAM role to EC2 and remove static/session credentials workflow.
3. Add AWS WAF to ALB.
4. Make ChatVSP ACM cert the ALB default certificate.
5. Replace broad default NACL with least-privilege subnet ACLs if feasible.
6. Reduce SSH exposure further or move to SSM Session Manager.

## Pricing / Cost Visibility Notes

Current documentation includes architecture and security posture. For pricing visibility, add:

- AWS Cost Allocation Tags (`Project=chatVSP`, `Env=dev/prod`, `Owner=`)
- Cost Explorer saved report filtered by those tags
- Budget alarms for ALB, EC2, EBS, data transfer, and OpenSearch usage

This repo does not currently contain a committed cost dashboard/runbook for those items.
