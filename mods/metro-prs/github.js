// Open pull requests from GitHub through `gh`: yours and the ones waiting on your review across every repo, one pull
// request's conversation and checks, reviewers' avatars, and the worktree a pull request is checked out in.
import { exec, home, appHome, readTextFile } from "herdr";

const FIELDS = `number title url isDraft createdAt updatedAt headRefName baseRefName isCrossRepository additions deletions changedFiles
  repository { nameWithOwner }
  author { login avatarUrl(size: 64) }
  reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login avatarUrl(size: 64) } ... on Team { name } } } }
  latestReviews(first: 20) { nodes { state submittedAt author { login avatarUrl(size: 64) } } }
  comments(last: 20) { totalCount nodes { createdAt author { login avatarUrl(size: 64) } } }
  commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }
  allCommits: commits { totalCount }`;

// When reviews were requested, for `askedAt`.
const REQUESTS = `timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 20) { nodes { ... on ReviewRequestedEvent {
  createdAt requestedReviewer { ... on User { login } ... on Team { slug } } } } }`;

const QUERY = `query($mine: String!, $asked: String!) {
  viewer { login avatarUrl(size: 64) }
  mine: search(query: $mine, type: ISSUE, first: 50) { nodes { ... on PullRequest { ${FIELDS} } } }
  asked: search(query: $asked, type: ISSUE, first: 50) { nodes { ... on PullRequest { ${FIELDS} ${REQUESTS} } } }
}`;

const DETAIL = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    reviews(last: 30) { nodes { state body submittedAt url author { login avatarUrl(size: 64) }
      comments(first: 10) { totalCount nodes { path line originalLine body } } } }
    comments(last: 30) { totalCount nodes { body createdAt url author { login avatarUrl(size: 64) } } }
    commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 50) { nodes {
      ... on CheckRun { name conclusion status } ... on StatusContext { context state } } } } } } }
  } }
}`;

async function graphql(query, fields) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(fields)) args.push(typeof v === "number" ? "-F" : "-f", `${k}=${v}`);
  const r = await exec("gh", args);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "gh api failed.").trim().split("\n")[0]);
  return JSON.parse(r.stdout).data;
}

// Every avatar URL a response names, by login, for `avatars`.
export const faces = {};
const seen = (author) => { if (author?.login && author.avatarUrl) faces[author.login] = author.avatarUrl; return author?.login ?? "ghost"; };

// When your review was last requested, directly or through a team; a new request is the only thing that changes it.
const askedAt = (pr, me) => pr.timelineItems.nodes.filter((e) => e.requestedReviewer?.slug || e.requestedReviewer?.login === me).at(-1)?.createdAt ?? pr.createdAt;

// { me, mine, asked }: the open pull requests you wrote and the ones asking for your review, the latest updated first.
// A pull request's `reviewers` are everyone but its author who reviewed or commented, with their latest verdict
// (APPROVED, CHANGES_REQUESTED or COMMENTED), changes requested first; `requested` are reviews asked for and not given.
export async function pulls() {
  const data = await graphql(QUERY, {
    mine: "is:pr is:open author:@me archived:false sort:updated-desc",
    asked: "is:pr is:open review-requested:@me archived:false sort:updated-desc",
  });
  const me = seen(data.viewer);
  const shape = (pr) => {
    const author = seen(pr.author);
    const verdict = new Map();
    for (const r of pr.latestReviews.nodes) {
      const login = seen(r.author);
      if (login !== author) verdict.set(login, { state: r.state, at: r.submittedAt });
    }
    for (const c of pr.comments.nodes) {
      const login = seen(c.author);
      if (login !== author && !verdict.has(login)) verdict.set(login, { state: "COMMENTED", at: c.createdAt });
    }
    const rank = { CHANGES_REQUESTED: 0, APPROVED: 1, COMMENTED: 2, DISMISSED: 3, PENDING: 3 };
    const reviewers = [...verdict].map(([login, v]) => ({ login, ...v })).filter((r) => r.state in rank)
      .sort((a, b) => rank[a.state] - rank[b.state]);
    const requested = pr.reviewRequests.nodes.map((n) => (n.requestedReviewer?.login ? seen(n.requestedReviewer) : n.requestedReviewer?.name))
      .filter((l) => l && !verdict.has(l));
    return { ...pr, author, repo: pr.repository.nameWithOwner, reviewers, requested, ci: pr.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null, head: pr.commits.nodes[0]?.commit.oid ?? null };
  };
  return { me, mine: data.mine.nodes.filter((n) => n.number).map(shape),
    asked: data.asked.nodes.filter((n) => n.number).map((pr) => ({ ...shape(pr), askedAt: askedAt(pr, me) })) };
}

// One pull request's conversation, newest first (comments, and reviews that said something, with their comments on
// files), and its checks: { events, checks }.
export async function conversation(pr) {
  const [owner, name] = pr.repo.split("/");
  const p = (await graphql(DETAIL, { owner, name, number: pr.number })).repository.pullRequest;
  const events = [
    ...p.comments.nodes.map((c) => ({ kind: "comment", state: "COMMENTED", login: seen(c.author), at: c.createdAt, body: c.body.trim(), url: c.url, inline: [], more: 0 })),
    ...p.reviews.nodes.filter((r) => r.body || r.state !== "COMMENTED" || r.comments.totalCount)
      .map((r) => ({ kind: "review", state: r.state, login: seen(r.author), at: r.submittedAt, body: r.body.trim(), url: r.url,
        inline: r.comments.nodes.map((c) => ({ path: c.path, line: c.line ?? c.originalLine, body: c.body.trim() })),
        more: r.comments.totalCount - r.comments.nodes.length })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const roll = p.commits.nodes[0]?.commit.statusCheckRollup;
  const checks = (roll?.contexts.nodes ?? []).map((c) => ({ name: c.name ?? c.context, state: c.conclusion ?? c.state ?? c.status ?? "PENDING" }));
  return { events, checks };
}

// Avatars are downloaded once to data/metro-prs/avatars/<login>.png, under Herdr's folder, where `image()` finds them.
export const AVATARS = "data/metro-prs/avatars";
export const avatarKey = (login) => login.replace(/[^A-Za-z0-9_.-]/g, "_");
export const avatarFile = (login) => `${AVATARS}/${avatarKey(login)}.png`;

// The logins whose avatar is already downloaded.
export async function cachedAvatars() {
  const r = await exec("ls", [`${appHome()}/${AVATARS}`]);
  return new Set(r.code === 0 ? r.stdout.split("\n").filter((f) => f.endsWith(".png")).map((f) => f.slice(0, -4)) : []);
}

// Downloads the avatars of these logins that aren't here yet; resolves with the ones it got.
export async function fetchAvatars(logins, have) {
  const want = [...new Set(logins)].filter((l) => faces[l] && !have.has(avatarKey(l)));
  if (!want.length) return [];
  await exec("mkdir", ["-p", `${appHome()}/${AVATARS}`]);
  const got = [];
  await Promise.all(want.map(async (l) => {
    const r = await exec("curl", ["-sfL", "--max-time", "15", "-o", `${appHome()}/${avatarFile(l)}`, faces[l]]);
    if (r.code === 0) got.push(l);
  }));
  return got;
}

// The approval rules and the repos whose issues stay out of the Issues tab, from the untracked metro-prs.json in
// Herdr's folder: { "approval": [{ "owners": ["acme"], "need": [["ana"], ["bo", "cy"]] }], "issues": { "skip": ["acme/site"] } }.
// A repo whose owner is listed needs an approval from someone in every group of `need`. Without the file, none:
// { rules, skip: lower-case "owner/repo"s, error }.
export async function approvalRules() {
  const text = await readTextFile(`${appHome()}/metro-prs.json`).catch(() => null);
  if (!text) return { rules: [], skip: new Set(), error: "" };
  try {
    const json = JSON.parse(text), rules = json.approval ?? [], skip = json.issues?.skip ?? [];
    if (!Array.isArray(rules) || rules.some((r) => !Array.isArray(r.owners) || !Array.isArray(r.need) || r.need.some((g) => !Array.isArray(g))))
      throw new Error('"approval" should be a list of { "owners": [...], "need": [[...], ...] }');
    if (!Array.isArray(skip) || skip.some((r) => typeof r !== "string" || !r.includes("/")))
      throw new Error('"issues": { "skip": [...] } should list repos as "owner/repo"');
    return { rules, skip: new Set(skip.map((r) => r.toLowerCase())), error: "" };
  } catch (e) {
    return { rules: [], skip: new Set(), error: `metro-prs.json: ${e.message ?? e}. Fix it, then refresh.` };
  }
}

// How far a pull request is approved under the rule for its repo's owner: { level: "full" | "part" | "none", n, of,
// met, need }, met[i] being who approved for need[i]; without a rule, null.
export function approval(pr, rules) {
  const rule = rules.find((r) => r.owners.includes(pr.repo.split("/")[0]));
  if (!rule) return null;
  const approvers = pr.reviewers.filter((r) => r.state === "APPROVED").map((r) => r.login);
  const met = rule.need.map((g) => g.filter((l) => approvers.includes(l)));
  const n = met.filter((g) => g.length).length;
  return { level: n === rule.need.length ? "full" : n ? "part" : "none", n, of: rule.need.length, met, need: rule.need };
}

// What happened on a pull request of yours worth telling you about, as tokens: each approval and each request for
// changes (by whom and when), and its checks failing on its latest push. metro-chrome repeats this to raise its dot
// and toasts; one not in shared `metro-prs.mine-seen` is new until the pull request is shown here.
export const updates = (pr) => [
  ...pr.reviewers.filter((r) => r.state === "APPROVED" || r.state === "CHANGES_REQUESTED").map((r) => `${r.state}:${r.login}:${r.at}`),
  ...(["FAILURE", "ERROR"].includes(pr.ci) && pr.head ? [`FAILED:${pr.head}`] : []),
];

// owner/repo from an origin URL in https, ssh or scp form.
export function repoOf(url) {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

// Asks nothing: a program with no terminal can't answer a password prompt.
const QUIET = ["GIT_TERMINAL_PROMPT=0", "GIT_SSH_COMMAND=ssh -o BatchMode=yes"];

// GitHub over HTTPS with gh's token, so an SSH origin never asks the SSH agent to sign: only here, as another machine
// may have no gh.
const overHttps = (on) => on ? [] : ["-c", "url.https://github.com/.insteadOf=git@github.com:", "-c", "url.https://github.com/.insteadOf=ssh://git@github.com/", "-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];

const git = async (cwd, args) => {
  const r = await exec("env", [...QUIET, "git", ...args], { cwd });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr || r.stdout || "").trim().split("\n")[0] };
};

// The main checkout of each GitHub repo among these folders: "owner/repo" (lower case) -> path.
export async function checkouts(folders) {
  const out = {};
  for (const folder of folders) {
    const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (!common.ok) continue;
    const main = common.out.replace(/\/\.git$/, "");
    if (Object.values(out).includes(main)) continue;
    const url = await git(main, ["remote", "get-url", "origin"]);
    const repo = url.ok ? repoOf(url.out) : null;
    if (repo) out[repo.toLowerCase()] = main;
  }
  return out;
}

const short = (repo) => repo.split("/")[1].toLowerCase();

// Whether a checkout's origin is this repo: by name, or by what GitHub calls it now, a moved or renamed repo still
// answering to its old name. A fork is its own repo.
export async function sameRepo(origin, repo) {
  if (origin.toLowerCase() === repo.toLowerCase()) return true;
  const r = await exec("gh", ["api", `repos/${origin}`, "--jq", ".full_name"]);
  return r.code === 0 && r.stdout.trim().toLowerCase() === repo.toLowerCase();
}

// The main checkout among `known` ("owner/repo" -> path) of a repo it lists under an old name, or null.
export async function renamed(repo, known) {
  for (const [origin, main] of Object.entries(known)) if (short(origin) === short(repo) && await sameRepo(origin, repo)) return main;
  return null;
}

// A clone of the repo in a folder of its name, beside the `known` checkouts or in home, or null.
export async function nearby(repo, known) {
  const parents = new Set([...Object.values(known).map((main) => main.slice(0, main.lastIndexOf("/"))), home()]);
  for (const parent of parents) {
    const path = `${parent}/${repo.split("/")[1]}`;
    if (!(await exists(path))) continue;
    const [origin, main] = Object.entries(await checkouts([path]))[0] ?? [];
    if (origin && await sameRepo(origin, repo)) return main;
  }
  return null;
}

// Clones owner/repo into this folder, which doesn't exist yet.
export async function clone(repo, path) {
  const r = await exec("env", [...QUIET, "gh", "repo", "clone", repo, path]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "gh repo clone failed.").trim().split("\n").pop().replace(/^fatal: /, ""));
}

export const exists = async (path) => (await exec("test", ["-e", path])).code === 0;

// Checkouts go to ~/.herdr/worktrees/<repo>/<branch, slashes as dashes>, as metro-worktree makes them.
const slug = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

// Commits of `ref` that were never on a remote. Everything `tracked` has pointed at counts as on one, as a force-push
// leaves what it replaced on no remote branch: its reflog, and the value before the log's first entry, `@{<entries>}`.
async function own(cwd, ref, tracked) {
  const seen = tracked ? (await git(cwd, ["reflog", "show", "--format=%H", tracked])).out.split("\n").filter(Boolean) : [];
  const first = seen.length ? await git(cwd, ["rev-parse", "--verify", "--quiet", `${tracked}@{${seen.length}}`]) : { ok: false };
  const r = await git(cwd, ["rev-list", "--count", ref, "--not", "--remotes", ...seen, ...(first.ok ? [first.out] : [])]);
  return r.ok ? Number(r.out) : Infinity;
}

// Why a checkout wasn't updated, short enough for a toast, and what to do about it.
const stale = (why, next) => ({ why, next: `${next}, then click Review locally again.` });

// Moves `branch` to the pull request's `tip`, in `folder` when it's checked out there, unless that would lose work.
// Resolves with what kept it from matching, as `stale`, or null. A pull request's force-push moves it too.
async function update(main, branch, tip, tracked, folder) {
  const ref = `refs/heads/${branch}`;
  const apart = await git(main, ["rev-list", "--left-right", "--count", `${ref}...${tip}`]);
  if (!apart.ok) return stale("Git couldn't compare it.", `${apart.err}. Fix that`);
  const [ahead, behind] = apart.out.split(/\s+/).map(Number);
  if (!ahead && !behind) return null;
  if (ahead && (await own(main, ref, tracked))) return stale("It has commits that aren't on origin.", tracked ? "Push or move them" : `The pull request may have been force-pushed. If they aren't yours, remove this worktree and delete ${branch}`);
  if (folder) {
    const changes = await git(folder, ["status", "--porcelain", "--untracked-files=no"]);
    if (!changes.ok || changes.out) return stale("It has uncommitted changes.", "Commit or stash them");
  }
  const move = folder ? await git(folder, ["reset", "--keep", "--quiet", tip]) : await git(main, ["branch", "--force", branch, tip]);
  return move.ok ? null : stale("Git couldn't move it.", `${move.err.replace(/^(error|fatal): /, "").replace(/\.$/, "")}. Fix that`);
}

// The folder where a pull request's branch is checked out, made a worktree of `main` when it isn't yet, and a warning
// when that checkout doesn't match the pull request, else null. A pull request from a fork is GitHub's pull/<n>/head,
// kept here as pr/<n>.
export async function checkout(main, pr) {
  const fork = pr.isCrossRepository;
  const branch = fork ? `pr/${pr.number}` : pr.headRefName;
  const source = fork ? `pull/${pr.number}/head` : `refs/heads/${branch}`;
  const tracked = fork ? null : `refs/remotes/origin/${branch}`;
  const fetched = await git(main, [...overHttps(null), "fetch", "--quiet", "--no-tags", "origin", fork ? source : `+${source}:${tracked}`]);
  const list = await git(main, ["worktree", "list", "--porcelain"]);
  const found = list.out.split(/\n\n+/).map((b) => b.split("\n"))
    .find((lines) => lines.includes(`branch refs/heads/${branch}`))?.find((l) => l.startsWith("worktree "))?.slice(9);
  const local = found || (await git(main, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).ok;
  if (!local && !fetched.ok) throw new Error(`Couldn't fetch ${fork ? `#${pr.number}` : branch} from origin: ${fetched.err}`);
  const tip = fetched.ok ? (await git(main, ["rev-parse", "FETCH_HEAD"])).out : null;
  const warning = !local ? null
    : tip ? await update(main, branch, tip, tracked, found)
    : stale("Origin couldn't be reached.", "This may not be the latest push. Check your connection");
  if (found) return { path: found, warning };
  const path = `${home()}/.herdr/worktrees/${main.split("/").pop()}/${slug(branch)}`;
  const add = await git(main, ["worktree", "add", "--quiet", ...(local ? [path, branch] : fork ? ["-b", branch, path, tip] : ["--track", "-b", branch, path, `origin/${branch}`])]);
  if (!add.ok) throw new Error(add.err || "git worktree add failed.");
  return { path, warning };
}

export const open = (url) => exec("open", [url]).catch(() => {});

// The board columns work starts from, nearest to done first. Boards spell them in either case ("This week").
export const COLUMNS = ["In Progress", "This Week", "New Week", "Estimation"];
const column = (name) => COLUMNS.find((c) => c.toLowerCase() === String(name ?? "").toLowerCase()) ?? null;

const BOARDS = `query { viewer { login organizations(first: 20) { nodes { projectsV2(first: 50) { nodes {
  id title url closed field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } } } } } } } }`;

const ITEMS = `items(first: 30, query: ${JSON.stringify(`is:issue is:open status:${COLUMNS.map((c) => (c.includes(" ") ? `"${c}"` : c)).join(",")}`)}) { nodes {
  id fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
  content { ... on Issue { number title url body createdAt updatedAt repository { nameWithOwner }
    author { login avatarUrl(size: 64) } assignees(first: 5) { nodes { login avatarUrl(size: 64) } }
    labels(first: 5) { nodes { name color } } comments { totalCount }
    closedByPullRequestsReferences(first: 3, includeClosedPrs: false) { nodes { number url title isDraft headRefName } } } } } }`;

// The project boards of your organizations that run the Niteo workflow (a Status column named Estimation), and your
// login: { me, boards: [{ id, title, url }] }. Asked rarely; the items are what change.
export async function boards() {
  const data = await graphql(BOARDS, {});
  const all = data.viewer.organizations.nodes.flatMap((o) => o?.projectsV2.nodes ?? []);
  return { me: data.viewer.login, boards: all.filter((b) => b && !b.closed && b.field?.options?.some((o) => o.name.toLowerCase() === "estimation"))
    .map((b) => ({ id: b.id, title: b.title, url: b.url, field: b.field.id, inProgress: b.field.options.find((o) => o.name.toLowerCase() === "in progress")?.id ?? null })) };
}

// The open issues in those columns of these boards that are yours or no one's, one per issue, nearest to done first,
// then the latest updated.
export async function issues({ me, boards }) {
  if (!boards.length) return [];
  const data = await graphql(`query { ${boards.map((b, i) => `b${i}: node(id: ${JSON.stringify(b.id)}) { ... on ProjectV2 { ${ITEMS} } }`).join("\n")} }`, {});
  const out = new Map();
  boards.forEach((b, i) => {
    for (const item of data[`b${i}`]?.items.nodes ?? []) {
      const c = item.content, col = column(item.fieldValueByName?.name);
      if (!c?.number || !col || out.has(c.url)) continue;
      const assignees = c.assignees.nodes.map(seen);
      if (assignees.length && !assignees.includes(me)) continue;
      out.set(c.url, { ...c, kind: "issue", author: seen(c.author), repo: c.repository.nameWithOwner, board: b.title, boardUrl: b.url, item: item.id, project: b.id, statusField: b.field, inProgress: b.inProgress, column: col, assignees,
        labels: c.labels.nodes, comments: c.comments.totalCount, linked: c.closedByPullRequestsReferences?.nodes ?? [] });
    }
  });
  return [...out.values()].sort((a, b) => COLUMNS.indexOf(a.column) - COLUMNS.indexOf(b.column) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

const MOVE = `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) { projectV2Item { id } }
}`;

// What failed and what to do about it; a missing scope says how to add it.
const failed = (e, what, button) => /scope/i.test(e)
  ? `Couldn't ${what}: GitHub needs the project scope. Run \`gh auth refresh -s project\` in a terminal, then click ${button} again.`
  : `Couldn't ${what}: ${e}. Try ${button} again, or do it on GitHub.`;

// Assigns the issue to you.
export async function assign(issue) {
  const r = await exec("gh", ["issue", "edit", String(issue.number), "--repo", issue.repo, "--add-assignee", "@me"]);
  if (r.code !== 0) throw new Error(failed((r.stderr || r.stdout || "gh issue edit failed").trim().split("\n")[0], "assign it to you", "Assign me"));
}

// Moves the issue's card on its board to In Progress.
export async function moveToInProgress(issue) {
  try { await graphql(MOVE, { project: issue.project, item: issue.item, field: issue.statusField, option: issue.inProgress }); }
  catch (e) { throw new Error(failed(`${e.message ?? e}`, "move it to In Progress", "Move to In Progress")); }
}

const ISSUE = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $number) {
    comments(last: 30) { nodes { body createdAt url author { login avatarUrl(size: 64) } } } } }
}`;

// An issue's comments, newest first, shaped as `conversation`'s events: { events }.
export async function issueConversation(issue) {
  const [owner, name] = issue.repo.split("/");
  const i = (await graphql(ISSUE, { owner, name, number: issue.number })).repository.issue;
  const events = i.comments.nodes.map((c) => ({ kind: "comment", state: "COMMENTED", login: seen(c.author), at: c.createdAt, body: c.body.trim(), url: c.url, inline: [], more: 0 }))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { events };
}

const SMALL = new Set(["a", "an", "the", "to", "of", "for", "in", "on", "and", "or", "with", "when", "from", "is", "be", "can", "it", "its", "that", "this", "as", "at", "by", "i", "e", "bug"]);

// A branch name for an issue, as branches are named here: fix/ for a bug, else feat/, then its number and a few words of
// its title: fix/331-scanned-expense-cent-off.
export function branchName(issue) {
  const bug = issue.labels.some((l) => /bug/i.test(l.name)) || /^(\[bug\]|fix\b)/i.test(issue.title);
  const words = issue.title.toLowerCase().replace(/\[[^\]]*\]/g, " ").replace(/`/g, "").split(/[^a-z0-9]+/).filter((w) => w && !SMALL.has(w)).slice(0, 4);
  return `${bug ? "fix" : "feat"}/${issue.number}${words.length ? `-${words.join("-")}` : ""}`;
}

// What a checkout already has for an issue, without asking origin: its branches here or on origin named after the
// issue's number (fix/331-…), local ones first, and origin's default branch as last seen: { branches, base }.
export async function issueBranches(main, number) {
  const refs = await git(main, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)", "refs/heads", "refs/remotes/origin"]);
  const head = await git(main, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const names = refs.out.split("\n").filter(Boolean)
    .map((r) => r.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\/origin\//, ""))
    .filter((b) => b !== "HEAD" && new RegExp(`(^|/)${number}(-|$)`).test(b));
  return { branches: [...new Set(names)], base: head.ok ? head.out.replace(/^origin\//, "") : null };
}

// Origin's default branch, asked of origin, as a checkout's origin/HEAD never follows a rename; the local one offline.
async function defaultBranch(main) {
  const r = await git(main, [...overHttps(null), "ls-remote", "--symref", "origin", "HEAD"]);
  const m = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(r.out);
  if (m) return m[1];
  const head = await git(main, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  return head.ok ? head.out.replace(/^origin\//, "") : null;
}

// The folder where `branch` is checked out, made a worktree of `main` when it isn't yet: the branch here, else the one
// on origin tracked, else a new branch off origin's latest default branch, not tracking it: { path }.
export async function start(main, branch) {
  const list = await git(main, ["worktree", "list", "--porcelain"]);
  const found = list.out.split(/\n\n+/).map((b) => b.split("\n"))
    .find((lines) => lines.includes(`branch refs/heads/${branch}`))?.find((l) => l.startsWith("worktree "))?.slice(9);
  if (found) return { path: found };
  const path = `${home()}/.herdr/worktrees/${main.split("/").pop()}/${slug(branch)}`;
  const check = await git(main, ["check-ref-format", "--branch", branch]);
  if (!check.ok) throw new Error(`${branch} can't be a branch name. Change it, then try again.`);
  let add;
  if ((await git(main, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).ok) add = [path, branch];
  else if ((await git(main, [...overHttps(null), "fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`])).ok)
    add = ["--track", "-b", branch, path, `origin/${branch}`];
  else {
    const base = await defaultBranch(main);
    if (!base) throw new Error("Couldn't tell origin's default branch. Check your connection, then try again.");
    const f = await git(main, [...overHttps(null), "fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`]);
    if (!f.ok) throw new Error(`Couldn't fetch ${base} from origin: ${f.err}. Check your connection, then try again.`);
    add = ["--no-track", "-b", branch, path, `origin/${base}`];
  }
  const r = await git(main, ["worktree", "add", "--quiet", ...add]);
  if (!r.ok) throw new Error(r.err || "git worktree add failed.");
  return { path };
}
