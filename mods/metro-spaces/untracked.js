// Lines in a checkout's untracked files, as `grep -cHI ''` counts them (a binary file has none). Each file's count is
// kept with its size and modification time in the machine's cache folder (~/.cache/herdr-metro/untracked), so a look
// reads only the files that are new or changed since. The same in metro-spaces and metro-review.
import { exec } from "herdr";

const SCRIPT = String.raw`
use strict; use warnings; use File::Path qw(make_path);
my ($name, $each) = @ARGV;
my $dir = ($ENV{XDG_CACHE_HOME} || "$ENV{HOME}/.cache") . "/herdr-metro/untracked";
my $cache = "$dir/$name";
my %old;
if (open(my $c, "<:raw", $cache)) {
  local $/ = "\0";
  while (defined(my $rec = <$c>)) { chomp $rec; my ($m, $s, $n, $p) = split /\t/, $rec, 4; $old{$p} = [$m, $s, $n] if defined $p; }
  close $c;
}
sub count {
  my ($p) = @_;
  open(my $f, "<:raw", $p) or return 0;
  local $/ = \1048576;
  my ($n, $last, $first) = (0, "", 1);
  while (defined(my $b = <$f>)) {
    if ($first) { return 0 if index(substr($b, 0, 32768), "\0") >= 0; $first = 0; }
    $n += ($b =~ tr/\n//);
    $last = substr($b, -1);
  }
  return 0 if $first;
  $n++ if $last ne "\n";
  return $n;
}
open(my $g, "-|", "git", "ls-files", "-z", "-o", "--exclude-standard") or exit 2;
binmode STDOUT;
my ($total, $changed, @keep) = (0, 0);
{
  local $/ = "\0";
  while (defined(my $p = <$g>)) {
    chomp $p;
    my @st = stat($p);
    next unless @st && -f _;
    my $o = delete $old{$p};
    my $n;
    if ($o && $o->[0] == $st[9] && $o->[1] == $st[7]) { $n = $o->[2]; } else { $n = count($p); $changed = 1; }
    $total += $n;
    push @keep, join("\t", $st[9], $st[7], $n, $p);
    print "$n\t$p\0" if $each;
  }
}
close $g or exit 3;
$changed ||= scalar(%old);
if ($changed) {
  eval {
    make_path($dir);
    open(my $w, ">:raw", "$cache.$$") or die;
    print $w map { "$_\0" } @keep;
    close $w or die;
    rename("$cache.$$", $cache) or die;
  };
}
print "$total\n" unless $each;
`;

// `top`: the checkout's top folder; `on`: its machine. Resolves with { total, files } (files: path -> lines, only
// when `perFile`).
export async function untrackedLines(top, on, { perFile = false } = {}) {
  const name = top.replace(/[^A-Za-z0-9._-]+/g, "_");
  try {
    const r = await exec("perl", ["-e", SCRIPT, name, perFile ? "1" : "0"], { cwd: top, on });
    if (r.code === 0) {
      if (!perFile) return { total: parseInt(r.stdout, 10) || 0, files: {} };
      const files = {};
      let total = 0;
      for (const rec of r.stdout.split("\0")) {
        const i = rec.indexOf("\t");
        if (i < 0) continue;
        const n = parseInt(rec.slice(0, i), 10) || 0;
        files[rec.slice(i + 1)] = n;
        total += n;
      }
      return { total, files };
    }
  } catch {}
  // Without perl there: every file counted each time.
  const r = await exec("sh", ["-c", "git ls-files -z -o --exclude-standard | xargs -0 grep -cHI ''"], { cwd: top, on });
  const files = {};
  let total = 0;
  for (const l of r.stdout.split("\n")) {
    const i = l.lastIndexOf(":");
    if (i <= 0) continue;
    const n = parseInt(l.slice(i + 1), 10) || 0;
    files[l.slice(0, i)] = n;
    total += n;
  }
  return { total, files };
}
