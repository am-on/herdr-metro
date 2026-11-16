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
  const view = await exec("gh", ["pr", "view", "--json", "number,url,state,isDraft,title,author,reviewDecision,latestReviews,comments,headRefOid,headRefName,isCrossRepository"], { cwd, on: machine });
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

// GitHub over HTTPS with gh's token, so an SSH origin never asks the SSH agent to sign: only here, as another machine
// may have no gh.
const overHttps = (on) => on ? [] : ["-c", "url.https://github.com/.insteadOf=git@github.com:", "-c", "url.https://github.com/.insteadOf=ssh://git@github.com/", "-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];

// How far origin's default branch has moved on since the branch checked out at cwd left it, fetched fresh
// without prompting: { base: "main", behind }, { base, failed: true } when origin can't be reached, or null (no origin,
// it is the default branch).
export async function staleness(cwd, machine, branch) {
  const git = (args) => exec("env", ["GIT_TERMINAL_PROMPT=0", "GIT_SSH_COMMAND=ssh -o BatchMode=yes -o ConnectTimeout=5", "git", ...overHttps(machine), ...args], { cwd, on: machine });
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

// Git at cwd over HTTPS, never prompting: { ok, out, err }.
const quiet = (cwd, machine) => async (args) => {
  const r = await exec("env", ["GIT_TERMINAL_PROMPT=0", "GIT_SSH_COMMAND=ssh -o BatchMode=yes -o ConnectTimeout=5", "git", ...overHttps(machine), ...args], { cwd, on: machine });
  return { ok: r.code === 0, code: r.code, out: r.stdout.trim(), err: (r.stderr || r.stdout || "").trim().split("\n").filter(Boolean).pop()?.replace(/^(error|fatal): /, "") ?? "" };
};

// Fetches an open pull request's head from origin: a fork's as GitHub's pull/<n>/head, else into origin/<branch>.
const fetchHead = (git, pr) => git(["fetch", "--quiet", "--no-tags", "origin", pr.isCrossRepository
  ? `refs/pull/${pr.number}/head` : `+refs/heads/${pr.headRefName}:refs/remotes/origin/${pr.headRefName}`]);

// Commits pushed to an open pull request on GitHub that the checkout at cwd doesn't have: { tip, count } (count null
// when they couldn't be fetched to count), or null. A tip the branch once had and moved on from (amended, rebased)
// isn't news. Fetches only when GitHub's tip isn't here yet.
export async function incoming(cwd, machine, branch, pr) {
  if (pr?.state !== "OPEN" || !pr.headRefOid) return null;
  const git = quiet(cwd, machine), tip = pr.headRefOid;
  const has = await git(["merge-base", "--is-ancestor", tip, "HEAD"]);
  if (has.ok) return null;
  if (has.code === 1) {
    const behind = await git(["merge-base", "--is-ancestor", "HEAD", tip]);
    const once = behind.ok ? null : await git(["reflog", "show", "--format=%H", `refs/heads/${branch}`]);
    if (once?.out.split("\n").includes(tip)) return null;
  } else if (!(await fetchHead(git, pr)).ok) return { tip, count: null };
  const count = await git(["rev-list", "--count", `HEAD..${tip}`]);
  return { tip, count: count.ok ? Number(count.out) : null };
}

// Brings the checkout at cwd to the pull request's tip: a fast-forward, or GitHub's force-push when every commit here
// is on origin. Resolves with how many commits came in; throws why it left the branch alone (its title) and what to do.
export async function pull(cwd, machine, branch, pr, tip) {
  const git = quiet(cwd, machine);
  const refuse = (title, body) => Object.assign(new Error(body), { title });
  if (!(await git(["cat-file", "-e", `${tip}^{commit}`])).ok) {
    const f = await fetchHead(git, pr);
    if (!f.ok) throw refuse(`Couldn't fetch #${pr.number}`, "Check your connection, then pull again.");
  }
  const changes = await git(["status", "--porcelain", "--untracked-files=no"]);
  if (!changes.ok || changes.out) throw refuse(`${branch} has uncommitted changes`, "Commit or stash them, then pull again.");
  const count = Number((await git(["rev-list", "--count", `HEAD..${tip}`])).out) || 0;
  if ((await git(["merge-base", "--is-ancestor", "HEAD", tip])).ok) {
    const ff = await git(["merge", "--ff-only", "--quiet", tip]);
    if (!ff.ok) throw refuse("Couldn't pull", `${ff.err}.`);
    return count;
  }
  // Commits here on no remote, the ones origin/<branch> once pointed at included: a force-push leaves those on none.
  const tracked = pr.isCrossRepository ? null : `refs/remotes/origin/${pr.headRefName}`;
  const seen = tracked ? (await git(["reflog", "show", "--format=%H", tracked])).out.split("\n").filter(Boolean) : [];
  const mine = await git(["rev-list", "--count", "HEAD", "--not", "--remotes", ...seen]);
  if (!mine.ok || Number(mine.out) > 0) throw refuse(`${branch} has commits not on GitHub`, `Rebase them onto #${pr.number}, then push.`);
  const move = await git(["reset", "--keep", "--quiet", tip]);
  if (!move.ok) throw refuse("Couldn't pull", `${move.err}.`);
  return count;
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
// A pull request's icon follows its state, as GitHub's do.
export const prIcon = (pr) => `mods/metro-chrome/icons/${pr.isDraft && pr.state === "OPEN" ? "git-pull-request-draft" : pr.state === "MERGED" ? "git-merge" : pr.state === "CLOSED" ? "git-pull-request-closed" : "git-pull-request"}.svg`;
export const prColor =(pr, t) => pr.isDraft && pr.state === "OPEN" ? t.dim : pr.state === "MERGED" ? t.ansi5 : pr.state === "CLOSED" ? t.blocked : t.ansi2;

// Open green, completed purple, not planned grey.
export const issueColor = (issue, t) => issue.state === "OPEN" ? t.ansi2 : issue.stateReason === "NOT_PLANNED" ? t.dim : t.ansi5;

export const open = (url) => exec("open", [url]).catch(() => {});

// Opens a draft pull request for the branch checked out at cwd, titled and described from its first commit, pushing
// the branch first when it has no upstream. Resolves with the pull request's URL; throws what went wrong.
export async function openDraft(cwd, machine, branch) {
  const git = (args) => exec("env", ["GIT_TERMINAL_PROMPT=0", "GIT_SSH_COMMAND=ssh -o BatchMode=yes -o ConnectTimeout=5", "git", ...overHttps(machine), ...args], { cwd, on: machine });
  const why = (r) => (r.stderr || r.stdout || "").trim().split("\n").filter(Boolean).pop()?.replace(/^(error|fatal): /, "") ?? "";
  const up = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (up.code !== 0) {
    const push = await git(["push", "--quiet", "-u", "origin", "HEAD"]);
    if (push.code !== 0) throw new Error(`Couldn't push ${branch}: ${why(push)}. Push it from a terminal, then try again.`);
  }
  const r = await exec("gh", ["pr", "create", "--draft", "--fill-first", "--head", branch], { cwd, on: machine });
  if (r.code !== 0) throw new Error(`Couldn't open a draft pull request: ${why(r)}. Try again, or open it on GitHub.`);
  return r.stdout.trim().split("\n").pop();
}
