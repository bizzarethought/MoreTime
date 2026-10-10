import { spawn } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function dependenciesReady(root) {
  try {
    const expected = JSON.parse(await readFile(resolve(root, 'more-time/package-lock.json'), 'utf8'));
    const installed = JSON.parse(await readFile(resolve(root, 'more-time/node_modules/.package-lock.json'), 'utf8'));
    if (!expected.packages?.[''] || !installed.packages || !Object.keys(installed.packages).length) return false;
    const fingerprint = lock => Object.entries(lock.packages ?? {})
      // npm legitimately omits optional binaries for other operating systems.
      .filter(([path, value]) => path !== '' && !(value.optional && !installed.packages[path]))
      .map(([path, value]) => [path, value.version, value.integrity, value.resolved, value.link])
      .sort(([a], [b]) => a.localeCompare(b));
    if (JSON.stringify(fingerprint(expected)) !== JSON.stringify(fingerprint(installed))) return false;
    await access(resolve(root, 'more-time/node_modules/.bin/tsx'));
    await access(resolve(root, 'more-time/node_modules/.bin/tsc'));
    return true;
  } catch { return false; }
}

function execute(command, args, cwd, options = {}) {
  const child = spawn(command, args, { cwd, stdio: 'inherit', ...options });
  const done = new Promise((resolveDone, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveDone({ code, signal }));
  });
  // Always observe errors, even while another service's exit is being handled.
  void done.catch(() => {});
  return { child, done };
}

async function command(commandName, args, root) {
  const result = await execute(commandName, args, root).done;
  if (result.code !== 0) throw new Error(`${commandName} ${args.join(' ')} failed. Startup stopped.`);
}

async function portAvailable(port) {
  const server = createServer();
  await new Promise((resolveReady, reject) => {
    server.once('error', () => reject(new Error(`Landing-page port ${port} is busy. Stop the existing server or use --port with a free port.`)));
    server.listen(port, '127.0.0.1', resolveReady);
  });
  await new Promise(resolveClosed => server.close(resolveClosed));
}

export async function main({ root = defaultRoot, args = process.argv.slice(2) } = {}) {
  let dev = false, check = false, port = 8000;
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--dev': dev = true; break;
      case '--check': check = true; break;
      case '--port': port = Number(args[++i]); break;
      case '--help':
        console.log('Usage: ./run.sh [--dev] [--check] [--port 8000]\n--dev: reload backend on edits\n--check: install dependencies if needed and run checks, without starting services\n--port: landing-page port; configure ALLOWED_ORIGINS when changing it');
        return;
      default: throw new Error(`Unknown option: ${args[i]}. Use --help.`);
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be between 1 and 65535.');
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('MoreTime needs Node.js 24 or newer.');
  await command('npm', ['--version'], root);
  if (!check) {
    await command('python3', ['--version'], root);
    await access(resolve(root, 'landing/dist/index.html'));
    await portAvailable(port);
  }
  if (!await dependenciesReady(root)) {
    console.log('Installing dependencies from the lockfile...');
    await command('npm', ['--prefix', 'more-time', 'ci'], root);
  } else console.log('Dependencies match the lockfile; installation skipped.');
  console.log('Checking TypeScript...');
  await command('npm', ['run', 'typecheck'], root);
  console.log('Running tests...');
  await command('npm', ['test'], root);
  if (check) { console.log('All startup checks passed.'); return; }

  // Each service gets its own process group so npm's Node children also stop.
  const services = [];
  let stopping = false;
  let forceStop;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const { child } of services) {
      if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
    }
    forceStop = setTimeout(() => {
      for (const { child } of services) {
        if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      }
    }, 3000);
  };
  const interrupt = () => stop();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    services.push(execute('python3', ['-u', '-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', resolve(root, 'landing/dist')], root, { detached: true }));
    services.push(execute('npm', ['run', dev ? 'dev' : 'start'], root, { detached: true }));
    console.log(`Starting MoreTime. Landing page: http://127.0.0.1:${port}. Backend startup will report readiness. Ctrl+C stops both.`);
    const result = await Promise.race(services.map(service => service.done));
    if (!stopping) {
      stop();
      throw new Error(`A service stopped (${result.signal ?? `exit ${result.code}`}). Both services are being stopped.`);
    }
  } finally {
    stop();
    await Promise.allSettled(services.map(service => service.done));
    // npm can exit before its descendants; terminate any remaining owned groups.
    for (const { child } of services) {
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    }
    clearTimeout(forceStop);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    const missingTool = error?.code === 'ENOENT';
    console.error(missingTool ? 'A required command or project file is missing. Check Node.js, npm, Python 3, and your checkout.' : error.message);
    process.exitCode = 1;
  });
}
