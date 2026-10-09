import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const commands = {
  'scan.mjs': [
    ['--dry-run', 'Preview without writing files'],
    ['--company <name>', 'Scan a single company'],
    ['--since <days>|--since=<days>', 'Only include postings within this many days'],
    ['--run-id <id>', 'Use an explicit scan run ID'],
    ['--verify', 'Check new URLs with Playwright'],
    ['--headed-fallback', 'Retry blocked verification in a headed browser'],
    ['--throttle[=<ms>]', 'Jitter verification checks (default base: 5000 ms)'],
    ['--rediscover-404', 'Search for moved postings during verification'],
  ],
  'merge-tracker.mjs': [
    ['--dry-run', 'Preview without writing files'],
    ['--verify', 'Verify pipeline integrity after merging'],
    ['--migrate', 'Normalize existing report links'],
    ['--migrate-via', 'Add the Via column to the tracker'],
  ],
  'dedup-tracker.mjs': [
    ['--dry-run', 'Preview without writing files'],
  ],
  'normalize-statuses.mjs': [
    ['--dry-run', 'Preview without writing files'],
  ],
  'reserve-report-num.mjs': [
    ['--count <N>', 'Reserve 1-50 contiguous report numbers (default: 1)'],
    ['--release <NNN>[-<MMM>]', 'Release a report number or range, e.g. 042-049'],
    ['--gc', 'Remove reservation sentinels older than four hours'],
  ],
};

// This must be the first import in each operational CLI: some later imports
// read configuration at module scope. Leave imports by tests unaffected.
const script = basename(process.argv[1] || '');
const options = commands[script];
if (options && pathToFileURL(process.argv[1]).href === new URL(`../${script}`, import.meta.url).href) {
  const args = process.argv.slice(2);
  const fail = (message) => {
    console.error(`${script}: ${message}\nUse --help for usage.`);
    process.exit(1);
  };
  const missingValues = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || !arg.startsWith('-')) continue;
    const option = options.find(([syntax]) => {
      const flag = syntax.match(/^--[\w-]+/)[0];
      return arg === flag || (syntax.includes('=') && arg.startsWith(`${flag}=`));
    });
    if (!option) fail(`Unknown flag: ${arg}`);
    const [syntax] = option;
    if (syntax.includes(' <') && !arg.includes('=')) {
      const value = args[i + 1];
      if (value == null || (value.startsWith('-') && !/^-\d/.test(value))) missingValues.push(arg);
      else i++;
    }
  }
  if (args.includes('--help')) {
    console.log(`Usage: node ${script} [options]\n\nOptions:`);
    for (const [syntax, description] of [...options, ['--help', 'Show this help and exit']]) {
      console.log(`  ${syntax.padEnd(34)} ${description}`);
    }
    process.exit(0);
  }
  if (missingValues.length > 0) fail(`${missingValues[0]} requires a value`);
}
