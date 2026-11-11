// Decides whether a job of ci.yml has anything to do for a pull request (docs/releasing.md "ci.yml"). Every job of
// ci.yml always starts (a required check that never reports blocks the merge) and asks this first, to spare the
// heavy steps when the pull request touches nothing the job covers.
//   <changed files, one per line, on stdin> | node scripts/ci-scope.mjs <node|app-rust|companion-rust>
// Prints `run=true` or `run=false` (a line for $GITHUB_OUTPUT) and a note on stderr. An empty list runs the job
// (nothing known is never "nothing to do").

const IGNORED_BY_NODE = [/^docs\//, /\.md$/, /^LICENSE$/, /^assets\//, /^tools\//, /^\.github\/workflows\/(build-app|build-companion|release|channels)\.yml$/];
const COVERED = {
  'app-rust': [/^app\//, /^package\.json$/, /^\.github\/workflows\/ci\.yml$/],
  'companion-rust': [/^companion\//, /^\.github\/workflows\/ci\.yml$/],
};

/** `{ run, reason }` for a job and the pull request's changed files. */
export function decide(job, files) {
  const list = files.map((f) => f.trim()).filter(Boolean);
  if (list.length === 0) return { run: true, reason: 'no changed files known' };
  if (job === 'node') {
    const rest = list.filter((f) => !IGNORED_BY_NODE.some((re) => re.test(f)));
    return rest.length ? { run: true, reason: `${rest.length} changed file(s) the node side covers, e.g. ${rest[0]}` } : { run: false, reason: 'only docs, tools and workflows of other jobs changed' };
  }
  const covered = COVERED[job];
  if (!covered) throw new Error(`unknown job ${job} (node, app-rust, companion-rust)`);
  const hit = list.find((f) => covered.some((re) => re.test(f)));
  return hit ? { run: true, reason: `${hit} changed` } : { run: false, reason: `nothing ${job} covers changed` };
}

// Only when run as the script (the test imports `decide`)
if (process.argv[1]?.endsWith('ci-scope.mjs')) {
  const job = process.argv[2];
  if (!job) {
    console.error('usage: ci-scope.mjs <node|app-rust|companion-rust>  (changed files on stdin)');
    process.exit(2);
  }
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const { run, reason } = decide(job, input.split('\n'));
  console.error(`${job}: ${run ? 'runs' : 'skipped'}: ${reason}`);
  console.log(`run=${run}`);
}
