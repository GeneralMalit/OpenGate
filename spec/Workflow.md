# Project workflow

## STEPS

### Step 1 - Frame the problem
The first step is to frame the problem. The main goal here is to define the goal and why it matters. This step is the single source of truth for the entire project. Capture the following and keep it in one place:
- Goal: the desired outcome in plain language.
- Business value: why the outcome matters and who benefits.
- Success metrics: how you will measure "done" (numbers, thresholds, or observable behavior).
- Constraints: time, compliance, performance, budget, team capacity, or platform limits.
- User story: "As a..., I want..., so that...".
- Acceptance criteria: happy path plus the most likely edge cases.
- Inputs/outputs: what the user provides, what the system returns, and who owns each piece.
- Behavior narrative: a short story of what the user does and how the system responds.
- Risks/unknowns: missing information or decisions that could change the plan.

Definition: task intake means collecting all of the above so the project has a crisp, shared problem statement.

### Step 2 - Model the data with AI assistance
Provide the behavior narrative and the domain vocabulary to the agent, then ask it to propose the data model. The agent should output entities, fields, relationships, and lifecycle rules (create, update, delete, archive). You review and correct, then approve the model.

What to give the agent:
- The behavior narrative from Step 1.
- A glossary of domain terms (even if short).
- The inputs and outputs that matter most.
- Any compliance or data retention constraints.
- Any existing systems or data that must be integrated.

What the agent should return:
- Entities with clear names and intent.
- Fields with types, required/optional flags, and defaults.
- Relationships and cardinality (one-to-one, one-to-many, many-to-many).
- Lifecycle rules (create/update/delete/archive/soft-delete).
- Integrity constraints or invariants that must never be violated.

How to review the model:
- Does every field exist to support an acceptance criterion?
- Are any fields trying to do two jobs at once?
- Is the model missing lifecycle states that the behavior narrative implies?
- Can the model explain the user story end to end without ad hoc hacks?

If the model is too big, ask the agent to produce an MVP-only model and a "later" model, then approve the MVP-only version first.

Definition: the data model is the minimal representation of the domain needed to support the behavior in Step 1.

### Step 3 - Define scope, features, and architecture
Decide what the MVP is and explicitly list what is excluded or deferred. Enumerate features that implement the user story plus required operational needs (observability, security, localization, billing, backups). Translate those features into architecture components: APIs, services, data stores, integrations, automation, and deployment/workflow impacts.

Scope clarity checklist:
- MVP: the smallest version that still delivers real user value.
- Exclusions: features that are intentionally not in the MVP.
- Deferrals: features that are important, but will come later.
- Non-goals: behavior the system should not attempt to support.

Feature mapping:
- For each feature, write a one-sentence purpose and which part of the user story it serves.
- Include operational features that keep the system healthy and safe.
- Identify any feature that depends on a risky assumption.

Architecture output:
- A simple component list (UI, API, data store, background jobs, integrations).
- Clear boundaries and data flow between components.
- One primary integration path for each external dependency.
- Deployment or workflow implications (CI, migrations, monitoring).

If you feel unclear, ask the agent to propose a minimal architecture that only supports the MVP, then iterate.

Definition: architecture is the set of components and boundaries required to deliver the MVP safely and reliably.

### Step 4 - Draft the spec
Convert Steps 1 to 3 into clear, testable statements. Use phrases like "The system must..." and "This flow cannot..." for functional behavior, and include non-functional targets such as latency, uptime, privacy, cost, and reliability. Include assumptions and explicitly call out out-of-scope items.

Spec structure guidance:
- Context: one short paragraph describing the project goal and user story.
- Functional requirements: numbered "The system must..." statements.
- Non-functional requirements: performance, reliability, privacy, security, cost.
- Data requirements: key entities, constraints, and data retention rules.
- Out of scope: explicit exclusions and deferrals.
- Open questions: items that still need decisions.

Spec quality checks:
- Every requirement is testable.
- Every acceptance criterion is represented.
- No requirement contradicts the constraints or non-goals.
- Assumptions are stated, not hidden.

Definition: the spec is the written contract that planning and testing are built from.

### Step 5 - Run the spec-driven loop
Ask 5.4 to reduce ambiguity by asking clarification questions. Answer them, revise the spec, and repeat until both sides declare satisfaction. Then ask 5.4 for a markdown execution plan and iterate on it. Before execution, ask "what are three things we are not considering?" and record the answers in the plan.

How to run the loop:
- Ask the agent to identify ambiguities, missing inputs, and conflicting requirements.
- Answer in plain language, then update the spec.
- Repeat until the agent states it has enough clarity to plan.

Planning output requirements:
- A markdown plan file with clear phases and checkable tasks.
- Explicit mapping back to the spec requirements.
- A short "risk notes" section for high-impact unknowns.

The "3 things" question:
- Ask it after the plan draft, before execution.
- Capture the answers in the plan and update the spec if needed.

Definition: the spec-driven loop is the systematic ambiguity reduction phase before implementation.

### Step 6 - Gate, test, and execute
Confirm readiness: goals and success metrics are measurable; user story and acceptance criteria are explicit; data models are approved; MVP scope and exclusions are written; the "3 things" answers are captured; and the plan is reviewed. Request tests first with a short comment on each test explaining its QA value. Execute the plan, log deviations and decisions, and keep the markdown history updated.

Readiness gate checklist:
- Measurable success metrics exist.
- Acceptance criteria are clear and testable.
- Data model is approved and matches the MVP.
- Plan is reviewed and aligned to the spec.
- Open questions are either resolved or explicitly deferred.

Test-first rules:
- Each test must map to a spec requirement.
- Each test includes a short QA justification comment.
- Prioritize tests for the happy path and highest-risk edge cases.

Execution and logging:
- Record decisions that are costly to reverse.
- Log deviations from the plan and why they happened.
- Update the spec or plan if reality changes.

Definition: the gate is the final checklist that prevents execution before the spec is stable.

### Step 7 - Define the product roadmap
After the MVP is stable, write a roadmap that explains how the project gets from "working" to "excellent". Focus on the upgrades that materially improve adoption, trust, scale, and maintainability. Treat the roadmap as a product spec for future work, not as a loose wish list.

The roadmap lives in [spec/roadmap.md](roadmap.md).

Roadmap content:
- Security hardening and key management.
- Developer experience and installability.
- Multi-framework support and adapter strategy.
- Storage backends for rate limiting and audit logs.
- Observability, monitoring, and operational controls.
- Admin workflows, policy management, and enterprise readiness.

Definition: the roadmap is the long-term product plan that shows how the MVP becomes a durable, 10/10 product.

## Notes
- Keep spec dialogue and plan iterations in markdown so the reasoning survives.
- Link project-specific notes back to this workflow when you evolve the process.

## Update Log
- 2026-03-24: Expanded the six-step workflow with explicit definitions, stronger intent capture, and a more prescriptive spec-driven loop.
- 2026-03-24: Restructured steps under H2/H3 headers and detailed Step 1 framing content.
