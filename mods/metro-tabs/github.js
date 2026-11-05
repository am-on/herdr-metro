// The GitHub repo of a checkout, the pull request of the branch checked out there, the issue its name starts with,
// and how far it is behind origin's default branch.
import { exec } from "herdr";

// owner/repo from an origin URL in https, ssh or scp form.
export function repoOf(url) {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

// The issue number a branch is named after: the first number starting a part of its name ("fix/312-scan", "312-scan").
export const issueNumberOf = (branch) => /(?:^|\/)(\d+)(?=[-_]|$)/.exec(branch ?? "")?.[1] ?? null;

// { repo, pr, issue }: repo is null outside a GitHub checkout; pr and issue are null when there's none.
export async function lookup(cwd, machine, branch) {
  const remote = await exec("git", ["remote", "get-url", "origin"], { cwd, on: machine });
  const repo = remote.code === 0 ? repoOf(remote.stdout) : null;
  if (!repo) return { repo: null, pr: null, issue: null };
  const view = await exec("gh", ["pr", "view", "--json", "number,url,state,isDraft,title,author,reviewDecision,latestReviews,comments"], { cwd, on: machine });
  let pr = null;
  try { if (view.code === 0) pr = withReview(JSON.parse(view.stdout)); } catch {}
  const n = issueNumberOf(branch);
  let issue = null;
  if (n) {
    const found = await exec("gh", ["issue", "view", n, "--json", "number,url,state,stateReason,title"], { cwd, on: machine });
    try { if (found.code === 0) issue = JSON.parse(found.stdout); } catch {}
  }
  return { repo, pr, issue };
}

// How far origin's default branch has moved on since the branch checked out at cwd left it, fetched fresh
// without prompting: { base: "main", behind }, { base, failed: true } when origin can't be reached, or null (no origin,
// it is the default branch).
export async function staleness(cwd, machine, branch) {
  const git = (args) => exec("env", ["GIT_TERMINAL_PROMPT=0", "GIT_SSH_COMMAND=ssh -o BatchMode=yes -o ConnectTimeout=5", "git", ...args], { cwd, on: machine });
  // Origin names its default branch itself: the local origin/HEAD keeps what it was at clone, so it only stands in offline.
  const asked = await git(["ls-remote", "--symref", "origin", "HEAD"]);
  const name = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(asked.stdout)?.[1];
  const head = name ? null : await git(["rev-parse", "--abbrev-ref", "origin/HEAD"]);
  let ref = name ? `origin/${name}` : head.code === 0 ? head.stdout.trim() : null;
  for (const r of ref ? [] : ["origin/main", "origin/master"]) {
    if ((await git(["rev-parse", "--verify", "--quiet", r])).code === 0) { ref = r; break; }
  }
  if (!ref?.startsWith("origin/")) return null;
  const base = ref.slice("origin/".length);
  if (branch === base) return null;
  if ((await git(["fetch", "--quiet", "--no-tags", "origin", base])).code !== 0) return { base, failed: true };
  const count = await git(["rev-list", "--count", `HEAD..${ref}`]);
  return count.code === 0 ? { base, behind: Number(count.stdout.trim()) } : null;
}

// What reviewers said on a pull request, its author's own reviews and comments left out: review.mark is the
// strongest of "changes", "approved" and "commented" (null when nobody has), review.who says who, in GitHub's words.
function withReview({ author, reviewDecision, latestReviews = [], comments = [], ...pr }) {
  const me = author?.login, others = (list) => [...new Set(list.map((x) => x.author?.login).filter((l) => l && l !== me))];
  const by = (state) => others(latestReviews.filter((r) => r.state === state));
  const changes = by("CHANGES_REQUESTED"), approved = by("APPROVED");
  const commented = others([...latestReviews.filter((r) => r.state === "COMMENTED"), ...comments]).filter((l) => !changes.includes(l) && !approved.includes(l));
  const mark = changes.length || reviewDecision === "CHANGES_REQUESTED" ? "changes"
    : approved.length || reviewDecision === "APPROVED" ? "approved" : commented.length ? "commented" : null;
  const who = [[changes, "Changes requested by"], [approved, "Approved by"], [commented, "Commented:"]]
    .filter(([l]) => l.length).map(([l, words]) => `${words} ${l.join(", ")}`).join(" · ");
  return { ...pr, review: { mark, who } };
}

// Draft grey, open green, merged purple, closed red, as GitHub colors them.
export const prColor = (pr, t) => pr.isDraft && pr.state === "OPEN" ? t.dim : pr.state === "MERGED" ? t.ansi5 : pr.state === "CLOSED" ? t.blocked : t.ansi2;

// Open green, completed purple, not planned grey.
export const issueColor = (issue, t) => issue.state === "OPEN" ? t.ansi2 : issue.stateReason === "NOT_PLANNED" ? t.dim : t.ansi5;

export const open = (url) => exec("open", [url]).catch(() => {});
