import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/auth";
import { Project } from "../models/Project";
import { ProjectTask } from "../models/ProjectTask";
import { Sprint } from "../models/Sprint";
import { Ticket, SLA_HOURS } from "../models/Ticket";
import { Asset } from "../models/Asset";
import { Deployment } from "../models/Deployment";
import { KbArticle } from "../models/KbArticle";
import { InfraResource } from "../models/InfraResource";
import { SystemService } from "../models/SystemService";
import { TeamMember } from "../models/TeamMember";
import { User } from "../models/User";

// One-shot convenience for standing the ICT workspace up with a
// realistic starting point instead of an empty screen. Idempotent-ish:
// running it twice creates a second batch rather than erroring, so
// it's meant to be run once per environment, not on every deploy.
export const seedIctDemoData = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const me = req.user!.userId;
    const anyUsers = await User.find({ isActive: true }).limit(5).select("_id");
    const userIds = anyUsers.length ? anyUsers.map((u) => u._id) : [me];
    const pick = (i: number) => userIds[i % userIds.length];

    const project = await Project.create({
      key: "PLAT",
      name: "Platform Migration to K8s",
      description:
        "Move core services off legacy VMs onto the Kubernetes cluster.",
      status: "active",
      priority: "high",
      risk: "medium",
      lead: pick(0),
      members: userIds,
      startDate: new Date(Date.now() - 10 * 86400000),
      dueDate: new Date(Date.now() + 30 * 86400000),
      milestones: [
        {
          title: "Staging cutover complete",
          date: new Date(Date.now() + 7 * 86400000),
          done: false,
        },
        {
          title: "Production cutover",
          date: new Date(Date.now() + 25 * 86400000),
          done: false,
        },
        {
          title: "Legacy VMs decommissioned",
          date: new Date(Date.now() + 35 * 86400000),
          done: false,
        },
      ],
      createdBy: me,
    });

    const sprint = await Sprint.create({
      projectId: project._id,
      name: "Sprint 4",
      goal: "Get staging fully on Kubernetes",
      startDate: new Date(Date.now() - 3 * 86400000),
      endDate: new Date(Date.now() + 11 * 86400000),
      status: "active",
      createdBy: me,
    });

    await ProjectTask.insertMany([
      {
        projectId: project._id,
        sprintId: sprint._id,
        title: "Migrate billing-service deployment manifests",
        column: "in_progress",
        assignee: pick(0),
        priority: "high",
        labels: ["k8s", "backend"],
        points: 5,
        createdBy: me,
      },
      {
        projectId: project._id,
        sprintId: sprint._id,
        title: "Set up horizontal pod autoscaling for API gateway",
        column: "todo",
        assignee: pick(1),
        priority: "medium",
        labels: ["k8s"],
        points: 3,
        createdBy: me,
      },
      {
        projectId: project._id,
        sprintId: sprint._id,
        title: "Write rollback runbook for cutover weekend",
        column: "done",
        assignee: pick(2),
        priority: "medium",
        labels: ["docs"],
        points: 2,
        completedAt: new Date(Date.now() - 86400000),
        createdBy: me,
      },
      {
        projectId: project._id,
        title: "Decommission legacy VM cluster",
        column: "backlog",
        assignee: pick(0),
        priority: "low",
        labels: ["cleanup"],
        points: 5,
        createdBy: me,
      },
    ]);

    await Ticket.insertMany([
      {
        ticketNumber: `TCK-${Date.now().toString().slice(-4)}1`,
        subject: "Laptop won't connect to office WiFi",
        requester: pick(1),
        department: "Sales",
        category: "network",
        priority: "medium",
        status: "open",
        slaDueAt: new Date(Date.now() + SLA_HOURS.medium * 3600000),
      },
      {
        ticketNumber: `TCK-${Date.now().toString().slice(-4)}2`,
        subject: "Production checkout API returning 502s",
        requester: pick(0),
        department: "ICT",
        category: "software",
        priority: "critical",
        status: "escalated",
        assignee: pick(0),
        slaDueAt: new Date(Date.now() + SLA_HOURS.critical * 3600000),
      },
      {
        ticketNumber: `TCK-${Date.now().toString().slice(-4)}3`,
        subject: "New hire onboarding — hardware setup",
        requester: pick(2),
        department: "HR",
        category: "hardware",
        priority: "medium",
        status: "in_progress",
        assignee: pick(1),
        slaDueAt: new Date(Date.now() + SLA_HOURS.medium * 3600000),
      },
    ]);

    await Asset.insertMany([
      {
        name: 'MacBook Pro 14" M3 — #A1042',
        type: "laptop",
        owner: pick(0),
        department: "ICT",
        status: "in_use",
        purchaseDate: new Date("2025-02-10"),
        warrantyExpiry: new Date("2027-02-10"),
        createdBy: me,
      },
      {
        name: "Cisco Catalyst 2960 — Server Room",
        type: "switch",
        department: "ICT",
        status: "in_use",
        purchaseDate: new Date("2023-01-20"),
        warrantyExpiry: new Date("2028-01-20"),
        createdBy: me,
      },
      {
        name: "Fortinet FortiGate 60F",
        type: "firewall",
        department: "ICT",
        status: "in_use",
        purchaseDate: new Date("2024-03-05"),
        warrantyExpiry: new Date("2027-03-05"),
        createdBy: me,
      },
    ]);

    await Deployment.insertMany([
      {
        project: "PeakInsights Hub",
        version: "v2.14.0",
        environment: "production",
        status: "scheduled",
        deployedBy: me,
        scheduledFor: new Date(Date.now() + 86400000),
        notes: "SSO rollout phase 1.",
      },
      {
        project: "PeakInsights Hub",
        version: "v2.13.2",
        environment: "production",
        status: "success",
        deployedBy: me,
        notes: "Hotfix for document upload timeout.",
      },
    ]);

    await KbArticle.insertMany([
      {
        title: "Onboarding a new employee: hardware & accounts checklist",
        category: "sop",
        author: me,
        body: "1. Provision laptop\n2. Create accounts\n3. Assign asset tag\n4. Schedule orientation.",
      },
      {
        title: "How to request VPN access",
        category: "user_guide",
        author: me,
        body: "Open a Help Desk ticket under Access, include your department and manager for approval.",
      },
      {
        title: "System architecture overview",
        category: "architecture",
        author: me,
        body: "High-level overview of the app tier, database, and storage layer.",
      },
    ]);

    await InfraResource.insertMany([
      {
        name: "app-prod-01",
        type: "server",
        region: "eu-west-1",
        status: "healthy",
        uptimePercent: 99.98,
        cpuPercent: 42,
        memoryPercent: 61,
        diskPercent: 48,
        responseMs: 112,
        lastHeartbeatAt: new Date(),
        createdBy: me,
      },
      {
        name: "mongo-primary",
        type: "database",
        region: "eu-west-1",
        status: "warning",
        uptimePercent: 99.71,
        cpuPercent: 74,
        memoryPercent: 82,
        diskPercent: 67,
        responseMs: 145,
        lastHeartbeatAt: new Date(),
        createdBy: me,
      },
      {
        name: "api-gateway",
        type: "api",
        region: "eu-west-1",
        status: "healthy",
        uptimePercent: 99.9,
        cpuPercent: 51,
        memoryPercent: 47,
        diskPercent: 20,
        responseMs: 88,
        lastHeartbeatAt: new Date(),
        createdBy: me,
      },
    ]);

    await SystemService.insertMany([
      {
        name: "PeakInsights Hub (web app)",
        type: "application",
        status: "running",
        owner: pick(0),
        lastRunAt: new Date(),
        createdBy: me,
      },
      {
        name: "Nightly DB backup job",
        type: "job",
        status: "failed",
        owner: pick(1),
        lastRunAt: new Date(),
        createdBy: me,
      },
      {
        name: "Email sync worker",
        type: "worker",
        status: "restart_required",
        owner: pick(2),
        lastRunAt: new Date(),
        createdBy: me,
      },
    ]);

    // A couple of manual roster entries, so the Team page isn't
    // limited to only whoever the seeded tasks/tickets above happen
    // to assign — this is the feature manual membership exists for.
    for (const uid of userIds.slice(0, 2)) {
      const alreadyOnRoster = await TeamMember.findOne({ userId: uid });
      if (!alreadyOnRoster) {
        await TeamMember.create({
          userId: uid,
          title: "ICT Team",
          addedBy: me,
        });
      }
    }

    res
      .status(201)
      .json({ success: true, message: "ICT demo data seeded", data: {} });
  } catch (err) {
    next(err);
  }
};
