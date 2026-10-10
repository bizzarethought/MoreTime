import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { dependenciesReady } from './run.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'moretime-run-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['bin', 'more-time/node_modules/.bin', 'landing/dist']) await mkdir(join(root, dir), { recursive: true });
  const installed = { packages: { 'node_modules/fixture': { version: '1.0.0', integrity: 'fictional-integrity' } } };
  const expected = { packages: { '': { name: 'fixture' }, ...installed.packages,
    'node_modules/optional-platform-binary': { version: '1.0.0', optional: true } } };
  await writeFile(join(root, 'more-time/package-lock.json'), JSON.stringify(expected));
  await writeFile(join(root, 'more-time/node_modules/.package-lock.json'), JSON.stringify(installed));
  for (const tool of ['tsx', 'tsc']) await writeFile(join(root, 'more-time/node_modules/.bin', tool), 'fixture');
  await writeFile(join(root, 'landing/dist/index.html'), '<html>fixture</html>');
  const toolSource = `#!/usr/bin/env node
const fs = require('node:fs');
const {spawn} = require('node:child_process');
const {basename} = require('node:path');
const tool = basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync('commands.log', tool + ' ' + args.join(' ') + '\\n');
if (args.includes('--version')) process.exit(0);
if (args.join(' ') === 'run typecheck') process.exit(process.env.FAIL_TYPES ? 7 : 0);
if (args.join(' ') === 'test') process.exit(0);
if (args.includes('ci')) {
  const lock = JSON.parse(fs.readFileSync('more-time/package-lock.json'));
  delete lock.packages[''];
  fs.writeFileSync('more-time/node_modules/.package-lock.json', JSON.stringify(lock));
  process.exit(0);
}
let descendant;
if (tool === 'npm') descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
fs.appendFileSync('services.log', JSON.stringify({tool, pid: process.pid, descendant: descendant?.pid}) + '\\n');
process.on('SIGTERM', () => {
  if (descendant) { descendant.once('exit', () => process.exit(0)); descendant.kill('SIGTERM'); }
  else process.exit(0);
});
setInterval(() => {}, 1000);
`;
  for (const tool of ['npm', 'python3']) await writeFile(join(root, 'bin', tool), toolSource, { mode: 0o755 });
  const moduleUrl = new URL('./run.mjs', import.meta.url).href;
  await writeFile(join(root, 'driver.mjs'), `import {main} from ${JSON.stringify(moduleUrl)}; main({root: ${JSON.stringify(root)}}).catch(error => {console.error(error.message); process.exitCode = 1;});`);
  return root;
}

function launch(root, args, env = {}) {
  const child = spawn(process.execPath, [join(root, 'driver.mjs'), ...args], { cwd: root,
    env: { ...process.env, ...env, PATH: `${join(root, 'bin')}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const done = new Promise((resolveDone, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveDone({ code, signal, output }));
  });
  return { child, done };
}

test('dependency gate accepts omitted optional packages and detects changed versions', async t => {
  const root = await fixture(t);
  assert.equal(await dependenciesReady(root), true);
  const installedPath = join(root, 'more-time/node_modules/.package-lock.json');
  const installed = JSON.parse(await readFile(installedPath));
  installed.packages['node_modules/fixture'].version = '2.0.0';
  await writeFile(installedPath, JSON.stringify(installed));
  assert.equal(await dependenciesReady(root), false);
});

test('check-only mode skips installation when ready, and installs when dependencies differ', async t => {
  const root = await fixture(t);
  assert.equal((await launch(root, ['--check']).done).code, 0);
  assert.equal(await readFile(join(root, 'commands.log'), 'utf8'), 'npm --version\nnpm run typecheck\nnpm test\n');
  const installedPath = join(root, 'more-time/node_modules/.package-lock.json');
  await rm(installedPath);
  assert.equal((await launch(root, ['--check']).done).code, 0);
  assert.match(await readFile(join(root, 'commands.log'), 'utf8'), /npm --prefix more-time ci/);
  await assert.rejects(readFile(join(root, 'services.log')));
});

test('failed typechecking stops before tests or service startup', async t => {
  const root = await fixture(t);
  const result = await launch(root, ['--check'], { FAIL_TYPES: '1' }).done;
  assert.equal(result.code, 1);
  assert.match(result.output, /Startup stopped/);
  assert.equal(await readFile(join(root, 'commands.log'), 'utf8'), 'npm --version\nnpm run typecheck\n');
  await assert.rejects(readFile(join(root, 'services.log')));
});

test('Ctrl+C stops both services and the backend descendant process', { timeout: 12_000 }, async t => {
  const root = await fixture(t);
  const server = createServer();
  await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
  const port = server.address().port;
  await new Promise(resolveClosed => server.close(resolveClosed));
  const run = launch(root, ['--dev', '--port', String(port)]);
  const services = [];
  t.after(() => {
    run.child.kill('SIGKILL');
    for (const service of services) {
      try { process.kill(-service.pid, 'SIGKILL'); } catch {}
    }
  });
  for (let i = 0; i < 100; i++) {
    try {
      const rows = (await readFile(join(root, 'services.log'), 'utf8')).trim().split('\n').map(JSON.parse);
      if (rows.length === 2) { services.push(...rows); break; }
    } catch {}
    await delay(30);
  }
  assert.equal(services.length, 2, 'both test services started');
  run.child.kill('SIGINT');
  assert.equal((await run.done).code, 0);
  const commands = await readFile(join(root, 'commands.log'), 'utf8');
  assert.match(commands, /npm run dev/);
  for (const pid of services.flatMap(service => [service.pid, service.descendant]).filter(Boolean)) {
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
});
