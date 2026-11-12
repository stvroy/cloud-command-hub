# Cloud Command Hub

**A cloud infrastructure monitoring platform for multi-account AWS environments.**

[**→ Live Demo**](https://stvroy.github.io/cloud-command-hub) &nbsp;·&nbsp; Built by Stephen O. Roy

---

## What it does

Cloud Command Hub gives engineering and operations teams a single pane of glass across their AWS infrastructure:

| Section | What you see |
|---|---|
| **Executive Summary** | Fleet health, pod counts, avg uptime, active alerts, monthly cost, security findings |
| **EC2 Instances** | Per-instance CPU / memory / disk with sparklines, fleet utilization gauges, multi-account view |
| **EKS Kubernetes** | Cluster utilization, node health, pod phases (running / pending / failed / OOMKilled), namespace breakdown |
| **Service Uptime** | 30-day uptime %, SSL certificate expiry, incident history, quarterly SLA cards |
| **Monthly Costs** | MTD vs forecast vs last month, daily spend trend, by-service breakdown, 12-month history, rightsizing |
| **IAM & Access** | MFA status, stale access keys, admin user count, per-account health score |
| **Threat Detection** | GuardDuty findings, security score, overpermissive security groups, VPCs without flow logs |
| **Volumes & S3** | EBS inventory, unattached volumes, orphaned snapshots, S3 public-access flags |
| **Network & ALB** | ALB request rates, EC2 network traffic, SSH login activity, VPC flow log status |
| **Active Alerts** | Incident feed with resolution workflow, history tab |
| **Container Health** | Per-host Docker container status across the fleet |

---

## Demo note

This repository contains the **demo frontend only**. It runs entirely in the browser — no backend required. All data shown is realistic mock data generated locally.

The full platform is maintained in a private repository and includes:

- **Python / FastAPI backend** with async multi-account AWS collectors (EC2, EKS, IAM, Cost, Storage, GuardDuty, ALB, Uptime Kuma)
- **Multi-account AWS support** via cross-account IAM roles across an AWS Organization
- **Kubernetes deployment** (Helm / kubectl, EKS) with Redis caching and PostgreSQL for metric history
- **Prometheus + Loki integration** for real-time instance metrics and log aggregation
- **CI/CD pipeline** (GitHub Actions → ECR → EKS rolling deploy)
- **Role-based access control** with admin approval workflow
- **PPTX report generation** for monthly infrastructure and uptime reports
- **FinOps cost attribution** via AWS CUR / Athena with per-application cost breakdown

Source code available on request.

---

## Tech stack

**Frontend** — Vanilla JS, CSS custom properties, no framework dependencies  
**Backend** — Python 3.12, FastAPI, boto3, Prometheus client, httpx  
**Infrastructure** — AWS EKS, ECR, Redis, PostgreSQL, Loki, Prometheus  
**Data** — AWS Cost and Usage Report (CUR) via Athena, Uptime Kuma, CloudWatch

---

## Contact

Stephen O. Roy — [LinkedIn](https://linkedin.com/in/stvroy) · [GitHub](https://github.com/stvroy)
