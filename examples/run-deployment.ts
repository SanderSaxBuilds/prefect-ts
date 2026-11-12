// Runs a deployment from the command line, prints its logs as they arrive and exits
// with the run's outcome. Works on Prefect Cloud and self-hosted servers.
//
//   PREFECT_API_URL=http://127.0.0.1:4200/api \
//   node --experimental-strip-types examples/run-deployment.ts etl/nightly '{"date":"2026-11-13"}'

import { PrefectClient, type Log } from '../src/index.ts';

const [name, json = '{}'] = process.argv.slice(2);
if (!name) {
  console.error('usage: run-deployment.ts <flow-name/deployment-name> [parameters-json]');
  process.exit(2);
}

const prefect = PrefectClient.fromEnv();
const run = await prefect.deployments.runByName(name, { parameters: JSON.parse(json) });
console.log(`created ${run.name} (${run.id})`);

let printed = 0;
const printNewLogs = async () => {
  const logs: Log[] = await prefect.flowRuns.logs(run.id, { offset: printed, limit: 200 });
  for (const log of logs) console.log(`${log.timestamp}  ${log.message}`);
  printed += logs.length;
};

// One log read at a time, so a slow read never prints the same lines twice.
let reading = Promise.resolve();
const finished = await prefect.flowRuns.wait(run.id, {
  pollIntervalMs: 2000,
  onPoll: () => {
    reading = reading.then(printNewLogs).catch(() => undefined);
  },
});
await reading;
await printNewLogs();

console.log(`${finished.name} ended ${finished.state_name}`);
process.exit(finished.state_type === 'COMPLETED' ? 0 : 1);
