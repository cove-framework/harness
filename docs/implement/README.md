# Cove — Implementation & Adoption Guide

Step-by-step instructions for a project **adopting and implementing** the Cove
framework: how to define agents, invoke them, wire up tools/skills/HITL, manage
sessions, compose subagents and workflows, connect channels, and ship to
production. This complements [`../design`](../design/README.md) (the architecture
and rationale — the "why") and [`../plans`](../plans/README.md) (the phase-by-phase
build roadmap — the "when"); this folder is the practical "how".

## Contents

| # | Page | What it covers |
| --- | --- | --- |
| 00 | [Overview & Mental Model](00-overview.md) | The core concepts and execution model you need before writing any code. |
| 01 | [Getting Started](01-getting-started.md) | Install, configure, and run your first Cove agent end to end. |
| 02 | [Defining Agents](02-defining-agents.md) | Author agents and profiles: instructions, models, and configuration. |
| 03 | [Invoking Agents](03-invoking-agents.md) | Call agents, stream results, and handle abort and lifecycle. |
| 04 | [Tools, Skills & Human-in-the-Loop](04-tools-skills-hitl.md) | Give agents capabilities and add approval gates for sensitive actions. |
| 05 | [Sessions & Compaction](05-sessions-and-compaction.md) | Persist conversation state and manage context as it grows. |
| 06 | [Subagents & Workflows](06-subagents-and-workflows.md) | Compose agents and orchestrate multi-step, durable processes. |
| 07 | [Channels (Slack & beyond)](07-channels.md) | Expose agents through Slack and other external surfaces. |
| 08 | [Deployment & Operations](08-deployment-and-operations.md) | Deploy, monitor, and operate Cove in production. |

## Where to start

Read in order, **00 → 08**. Each page builds on the previous one; start at
[00 — Overview & Mental Model](00-overview.md).
