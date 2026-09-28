import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { buildReleaseReport, writeReleaseReport } from './evaluation/report';

/** Usage: tsx scripts/report-release.ts RUN_DIRECTORY [RUN_DIRECTORY ...] --out FRESH_REPORT_DIRECTORY */
export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { out: { type: 'string' } } });
  if (!values.out || positionals.length === 0) throw new Error('Provide run directories and --out with a fresh report directory');
  const report = await buildReleaseReport(positionals);
  const paths = await writeReleaseReport(report, values.out);
  console.log(JSON.stringify(paths, null, 2));
  return paths;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Report generation failed'); process.exitCode = 1; });
}
