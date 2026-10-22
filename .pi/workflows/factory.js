// Factory: spec (Opus) → implement (Sonnet) → review lenses (Opus, parallel)
// → revise ≤ maxRounds (Sonnet) → PR (Sonnet). See .pi/factory.md.
//
// args: { repo, issue, slug, worktree, branch, lenses?: string[], maxRounds?: number, seam?: boolean }
// seam: the change is a shared foundation later issues build on (label `seam`); reviewers
// then rate inherited defects by blast radius.
// The caller creates `worktree` on `branch` before launching; every stage runs there.

const OPUS = "claude-bridge/claude-opus-5-5";
const SONNET = "claude-bridge/claude-sonnet-5-5";
const SPEC_URL =
  "https://raw.githubusercontent.com/seandavi/bioc-infrastructure/spec/mcp/proposal-mcp.qmd";

const repo = args.repo;
const issue = args.issue;
const cwd = args.worktree;
const branch = args.branch;
const lenses = args.lenses && args.lenses.length ? args.lenses : ["code"];
const maxRounds = args.maxRounds || 2;
const seam = !!args.seam;
const SEAM_NOTE = seam
  ? `\nThis change is a SHARED SEAM: later issues build adapters and modules on it. Rate by blast
radius, not by current reach: a defect every later caller would inherit or copy (a guard that can
be bypassed, a missing validation, a leaky contract) is at least "major", even if nothing reaches
it yet.`
  : "";
const specPath = `docs/specs/${issue}-${args.slug}.md`;

const COMMON = `
Repository: ${repo}, issue #${issue}. Working directory (a git worktree on branch ${branch}): ${cwd}
Read AGENTS.md in that directory first and follow it. The design spec for the whole project is
${SPEC_URL} (fetch it with curl if you need it).
Work only inside ${cwd}. Never touch main, never merge, never force-push, never git stash.
Commit with: git -c user.name="Sean Davis" -c user.email=seandavi@gmail.com commit
and add the trailer "Co-Authored-By: Claude <noreply@anthropic.com>".`;

const LENS = {
  code: `CODE review. Correctness against the issue spec and its acceptance criteria; tests that
would actually catch a regression (fixtures, no network); the one-capability-two-transports rule
(no logic in transports/); deep modules with clear seams; type safety; dead code; dependency choices
against AGENTS.md.`,
  ux: `AGENT + DEVELOPER UX review. Tool names; descriptions that say what the tool answers and
when to use another tool instead; input/output schema clarity and defaults; error messages an agent
can act on; result size (≤ ~8 KB text) and pagination; provenance on every result; REST paths,
query params and OpenAPI quality; README/connection instructions for a first-time user.`,
  security: `SECURITY review. SSRF (no capability fetches a caller-supplied URL or host); input
validation and bounds; secret handling (code, fixtures, logs, CI); fork-PR CI safety (no secrets on
pull_request, no pull_request_target); Host/Origin allowlist; rate limiting; that nothing
non-public can be returned.`,
};

const statusSchema = (extra) => ({
  type: "object",
  required: ["status"],
  properties: Object.assign({ status: { type: "string", enum: ["done", "blocked"] } }, extra),
});
const checksSchema = {
  type: "object",
  properties: {
    tests: { type: "string", enum: ["pass", "fail", "n/a"] },
    typecheck: { type: "string", enum: ["pass", "fail", "n/a"] },
  },
};
const reviewSchema = {
  type: "object",
  required: ["verdict", "findings"],
  properties: {
    verdict: { type: "string", enum: ["approve", "changes"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "severity", "location", "problem", "fix"],
        properties: {
          id: { type: "string" },
          severity: { type: "string", enum: ["blocker", "major", "minor", "nit"] },
          location: { type: "string" },
          problem: { type: "string" },
          fix: { type: "string" },
        },
      },
    },
  },
};

// ---- 1. Spec -------------------------------------------------------------------------
const spec = await runs.run("spec", {
  label: `Spec issue #${issue}`,
  agent: "worker",
  model: OPUS,
  cwd,
  outputSchema: {
    type: "object",
    required: ["status", "spec_path", "blocking_questions"],
    properties: {
      status: { type: "string", enum: ["ready", "blocked"] },
      spec_path: { type: "string" },
      blocking_questions: { type: "array", items: { type: "string" } },
    },
  },
  task: `${COMMON}

You are the SPEC stage. Do not write any code.
1. Read the issue: gh issue view ${issue} -R ${repo} --comments. Read the project spec and AGENTS.md.
2. Write ${specPath}: Goal; Non-goals; Design (files to add/change, exported interfaces, zod
   schemas for every capability's input and output, MCP tool and REST route for each, upstream
   calls with example URLs and fixture files to record); Acceptance criteria as a testable
   checklist; Test plan; Risks. Be concrete enough that an implementer never has to choose a
   library or an interface. Verify package APIs you rely on (npm view, or read the package's docs)
   rather than guessing.
3. Commit only that file ("Spec for #${issue}").
Set status "blocked" only if a question has two reasonable answers with materially different
outcomes that the issue and project spec do not settle; list them in blocking_questions.`,
});
const specOut = spec.structuredOutput || {};
if (!spec.ok || specOut.status !== "ready") {
  return { stage: "spec", stopped: true, spec: specOut, error: spec.error || null };
}

// ---- 2. Implement --------------------------------------------------------------------
const impl = await runs.run("implement", {
  label: `Implement issue #${issue}`,
  agent: "worker",
  model: SONNET,
  cwd,
  outputSchema: statusSchema({
    summary: { type: "string" },
    changed_files: { type: "array", items: { type: "string" } },
    checks: checksSchema,
  }),
  task: `${COMMON}

You are the IMPLEMENT stage. Implement exactly ${specPath}; it is the contract. Do not redesign.
Work in the foreground (never leave background processes running). Record fixtures by fetching
the upstream URLs once with curl into test/fixtures/; tests must not use the network.
Run the install, typecheck and test commands and fix failures. Commit in small, well-described
commits. Report changed_files (paths relative to the repo root) and check results.
Set status "blocked" if the spec is wrong or impossible; explain in summary.`,
});
const implOut = impl.structuredOutput || {};
if (!impl.ok || implOut.status !== "done") {
  return { stage: "implement", stopped: true, spec: specOut, implement: implOut, error: impl.error || null };
}

// ---- 3. Review, 4. Revise (≤ maxRounds) -----------------------------------------------
function reviewTask(lens, files, round) {
  return `${COMMON}

You are a READ-ONLY reviewer (round ${round}). Lens: ${LENS[lens]}${SEAM_NOTE}
Read ${specPath}, AGENTS.md and the changed files: ${files.join(", ")}.
Read any other file you need. Do not edit anything.
Report findings with severity: blocker (wrong or unsafe; must fix), major (should fix before merge),
minor, nit. Give each an id of the form "${lens}-r${round}-<n>" (e.g. "${lens}-r${round}-1");
when a finding repeats one from an earlier round, say so in problem. verdict is "changes" only if there is at
least one blocker or major finding. Do not pad: zero findings is a valid review.`;
}
function reviewBatch(lensList, files, round) {
  return runs.all(lensList.map((lens) => ({
    key: `review-${lens}-r${round}`,
    label: `Review issue #${issue} ${lens} r${round}`,
    agent: "reviewer",
    model: OPUS,
    cwd,
    outputSchema: reviewSchema,
    task: reviewTask(lens, files, round),
  })));
}
function blocking(results, lensList) {
  const out = [];
  results.forEach((r, i) => {
    const s = r.structuredOutput || { verdict: "changes", findings: [{ id: `${lensList[i]}-error`, severity: "major", location: "-", problem: `review failed: ${r.error || "no structured output"}`, fix: "re-run review" }] };
    (s.findings || []).forEach((f) => {
      if (f.severity === "blocker" || f.severity === "major") out.push(Object.assign({ lens: lensList[i] }, f));
    });
  });
  return out;
}
function minors(results, lensList) {
  const out = [];
  results.forEach((r, i) => {
    ((r.structuredOutput || {}).findings || []).forEach((f) => {
      if (f.severity === "minor" || f.severity === "nit") out.push(Object.assign({ lens: lensList[i] }, f));
    });
  });
  return out;
}

let files = implOut.changed_files || [];
let checks = implOut.checks || {};
let activeLenses = lenses.slice();
let results = await reviewBatch(activeLenses, files, 0);
let open = blocking(results, activeLenses);
let followUps = minors(results, activeLenses);
const history = [{ round: 0, lenses: activeLenses, blocking: open.length }];
let round = 0;

while (open.length && round < maxRounds) {
  round += 1;
  const rev = await runs.run(`revise-r${round}`, {
    label: `Revise issue #${issue} r${round}`,
    agent: "worker",
    model: SONNET,
    cwd,
    outputSchema: statusSchema({
      responses: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "action"],
          properties: {
            id: { type: "string" },
            action: { type: "string", enum: ["fixed", "declined"] },
            note: { type: "string" },
          },
        },
      },
      changed_files: { type: "array", items: { type: "string" } },
      checks: checksSchema,
    }),
    task: `${COMMON}

You are the REVISE stage, round ${round} of at most ${maxRounds}. Address these review findings:
${JSON.stringify(open, null, 2)}
Fix each, or decline it with a one-line reason if it contradicts ${specPath} or AGENTS.md.
Re-run typecheck and tests. Commit ("Address review round ${round} for #${issue}").
Report every finding id in responses and all files you changed.`,
  });
  const revOut = rev.structuredOutput || {};
  if (!rev.ok || revOut.status !== "done") {
    history.push({ round, stopped: true, error: rev.error || null });
    break;
  }
  files = Array.from(new Set(files.concat(revOut.changed_files || [])));
  checks = revOut.checks || checks;
  activeLenses = Array.from(new Set(open.map((f) => f.lens)));
  results = await reviewBatch(activeLenses, files, round);
  open = blocking(results, activeLenses);
  followUps = followUps.concat(minors(results, activeLenses));
  history.push({ round, lenses: activeLenses, blocking: open.length, responses: revOut.responses || [] });
}

// ---- 5. PR -------------------------------------------------------------------------
const checksFailing = checks.tests === "fail" || checks.typecheck === "fail";
const draft = open.length > 0 || checksFailing;
const pr = await runs.run("pr", {
  label: `Open PR for issue #${issue}`,
  agent: "worker",
  model: SONNET,
  cwd,
  outputSchema: {
    type: "object",
    required: ["pr_url"],
    properties: { pr_url: { type: "string" }, draft: { type: "boolean" } },
  },
  task: `${COMMON}

You are the PR stage. Do not change code.
1. git push -u origin ${branch}
2. gh pr create -R ${repo} --base main --head ${branch} ${draft ? "--draft " : ""}with a title
   naming the change and a body containing: "Closes #${issue}"; a short summary from ${specPath};
   a "Factory record" section (review rounds: ${JSON.stringify(history)}; checks: ${JSON.stringify(checks)});
   ${open.length ? `an "Unresolved review findings" section listing: ${JSON.stringify(open)};` : ""}
   a "Follow-ups (minor/nit)" checklist from: ${JSON.stringify(followUps)}.
3. Report the PR URL.`,
});

return {
  issue,
  pr: (pr.structuredOutput || {}).pr_url || null,
  draft,
  spec: specOut.spec_path,
  checks,
  rounds: history,
  unresolved: open,
  followUps: followUps.length,
};
