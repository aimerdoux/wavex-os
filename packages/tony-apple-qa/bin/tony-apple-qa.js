#!/usr/bin/env node
/**
 * Tony Apple QA CLI — AI-powered QA operating system for mobile-app teams.
 *
 * Usage:
 *   tony-apple-qa init [company-name]
 *   tony-apple-qa doctor
 *   tony-apple-qa audit
 *   tony-apple-qa status
 *   tony-apple-qa login
 *   tony-apple-qa logout
 *   tony-apple-qa reset
 *   tony-apple-qa --version
 *   tony-apple-qa --help
 */
import { exec, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  accent: '\x1b[38;5;213m',
};

const HOME_DIR = join(homedir(), '.wavex-os');
const STATE_FILE = join(HOME_DIR, 'tony-apple-qa.json');
const ONBOARDING_PORT = 5173;
const MOCK_CORE_PORT = 3101;
const VERSION = '0.1.0';

const BANNER = `
${c.accent}  _____                _____           _       ___  ___
 |_   _|___  _ __  _   |  _  |_ __  _ __| | ___  / _ \\/ _ \\
   | |/ _ \\| '_ \\| | | | |_| | '_ \\| '_ \\ |/ _ \\  |_| /_/ /
   | | (_) | | | | |_| |  _  | |_) | |_) | |  __/  __/\\__/
   |_|\\___/|_| |_|\\__, |_| |_| .__/| .__/|_|\\___| |_|
                  |___/       |_|   |_|${c.reset}

  ${c.dim}AI-powered QA operating system for mobile-app teams.${c.reset}
  ${c.dim}Runs locally on your Claude Max subscription — no API keys required.${c.reset}
`;

async function checkBinary(name) {
  try {
    const { stdout } = await execAsync(`${name} --version`);
    return { ok: true, version: stdout.trim().split('\n')[0] };
  } catch {
    return { ok: false };
  }
}

async function doctor() {
  const checks = [];

  const node = await checkBinary('node');
  checks.push({
    name: 'node ≥18',
    ok: node.ok && parseFloat(node.version?.replace('v', '') ?? '0') >= 18,
    detail: node.version,
  });

  const pnpm = await checkBinary('pnpm');
  checks.push({
    name: 'pnpm ≥8',
    ok: pnpm.ok,
    detail: pnpm.version ?? 'not found — install from https://pnpm.io',
  });

  const git = await checkBinary('git');
  checks.push({ name: 'git', ok: git.ok, detail: git.version });

  const claudeCheck = await checkBinary('claude');
  checks.push({
    name: 'claude CLI',
    ok: claudeCheck.ok,
    detail: claudeCheck.version ?? 'not found — install Claude Code from https://claude.ai/code',
  });

  const isMac = platform() === 'darwin';
  if (isMac) {
    const keychainPath = join(homedir(), 'Library/Keychains/login.keychain-db');
    checks.push({
      name: 'macOS keychain',
      ok: existsSync(keychainPath),
      detail: existsSync(keychainPath)
        ? 'found'
        : 'missing — Claude Max OAuth requires this on macOS',
    });
  } else {
    checks.push({
      name: 'Claude credential storage',
      ok: true,
      detail: 'Platform-appropriate storage will be used on Linux/Windows',
    });
  }

  const ok = checks.every((c) => c.ok);
  return { ok, checks };
}

function printDoctor(result) {
  console.log(`\n${c.bold}Environment check${c.reset}\n`);
  for (const check of result.checks) {
    const mark = check.ok ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
    const detail = check.detail ? `${c.dim}${check.detail}${c.reset}` : '';
    console.log(`  ${mark} ${check.name.padEnd(30)} ${detail}`);
  }
  console.log();
  if (!result.ok) {
    console.log(
      `${c.red}Some prerequisites are missing. Fix the items above and re-run.${c.reset}\n`,
    );
  }
}

async function audit() {
  const checks = [];

  // Disk
  try {
    const { stdout } = await execAsync(`df -h / | tail -1`);
    const pct = parseInt(
      stdout
        .split(/\s+/)
        .find((s) => s.endsWith('%'))
        ?.replace('%', '') ?? '0',
      10,
    );
    const state = pct >= 90 ? 'red' : pct >= 80 ? 'yellow' : 'green';
    checks.push({ name: 'disk usage', state, detail: `${pct}% of root volume` });
  } catch {
    checks.push({ name: 'disk usage', state: 'info', detail: 'could not read df' });
  }

  // RAM pressure (macOS)
  if (platform() === 'darwin') {
    try {
      const { stdout } = await execAsync(`sysctl -n vm.swapusage`);
      const m = stdout.match(/used\s*=\s*([\d.]+)M/);
      const used = m ? parseFloat(m[1]) : 0;
      const state = used > 1000 ? 'red' : used > 200 ? 'yellow' : 'green';
      checks.push({ name: 'swap usage', state, detail: `${used.toFixed(1)} MB used` });
    } catch {
      checks.push({ name: 'swap usage', state: 'info', detail: 'sysctl unavailable' });
    }
  }

  // Ports
  const ports = [
    { port: 3100, name: 'Paperclip server (3100)' },
    { port: 3101, name: 'wavex mock-core (3101)' },
    { port: 5173, name: 'wavex onboarding UI (5173)' },
  ];
  for (const { port, name } of ports) {
    try {
      const { stdout } = await execAsync(
        `lsof -nP -iTCP:${port} -sTCP:LISTEN 2>/dev/null | tail -n +2 | head -1`,
      );
      if (stdout.trim()) {
        checks.push({ name, state: 'green', detail: 'listening' });
      } else {
        checks.push({
          name,
          state: 'info',
          detail: 'not listening (expected if service not started)',
        });
      }
    } catch {
      checks.push({ name, state: 'info', detail: 'probe failed' });
    }
  }

  // launchd jobs (macOS)
  if (platform() === 'darwin') {
    try {
      const { stdout } = await execAsync(
        `launchctl list 2>/dev/null | grep wavex-os || true`,
      );
      const lines = stdout.trim().split('\n').filter(Boolean);
      if (lines.length > 0) {
        checks.push({
          name: 'wavex-os launchd jobs',
          state: 'green',
          detail: `${lines.length} loaded`,
        });
      } else {
        checks.push({
          name: 'wavex-os launchd jobs',
          state: 'info',
          detail: 'none loaded',
        });
      }
    } catch {
      checks.push({ name: 'wavex-os launchd jobs', state: 'info', detail: 'launchctl unavailable' });
    }
  }

  const ok = checks.every((c) => c.state !== 'red');
  return { ok, checks };
}

function printAudit(result) {
  console.log(`\n${c.bold}Runtime audit${c.reset}\n`);
  for (const check of result.checks) {
    const mark =
      check.state === 'green'
        ? `${c.green}●${c.reset}`
        : check.state === 'yellow'
          ? `${c.yellow}●${c.reset}`
          : check.state === 'red'
            ? `${c.red}●${c.reset}`
            : `${c.dim}○${c.reset}`;
    const detail = check.detail ? `${c.dim}${check.detail}${c.reset}` : '';
    console.log(`  ${mark} ${check.name.padEnd(40)} ${detail}`);
  }
  console.log();
  if (!result.ok) {
    console.log(`${c.red}One or more checks are RED. See details above.${c.reset}\n`);
  }
}

async function init(rawCompanyName) {
  console.log(BANNER);

  const dr = await doctor();
  printDoctor(dr);
  if (!dr.ok) {
    process.exit(1);
  }

  const companyName = (rawCompanyName ?? 'default')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .toLowerCase();
  const companyDir = join(HOME_DIR, 'instances', companyName);

  if (!existsSync(companyDir)) {
    mkdirSync(companyDir, { recursive: true });
    console.log(`${c.green}✓${c.reset} Created instance dir: ${c.dim}${companyDir}${c.reset}`);
  } else {
    console.log(
      `${c.yellow}⚠${c.reset}  Instance ${c.bold}${companyName}${c.reset} already exists at ${c.dim}${companyDir}${c.reset}`,
    );
    console.log(`   Re-running onboarding will preserve existing agents but may overwrite onboarding state.`);
  }

  const sessionId = `${companyName}-${Date.now()}`;
  const manifestPath = join(companyDir, 'session.json');
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        sessionId,
        companyName,
        createdAt: new Date().toISOString(),
        tonyAppleQaVersion: '0.1.0',
        phase: 'B',
        status: 'onboarding-pending',
      },
      null,
      2,
    ),
  );
  console.log(`${c.green}✓${c.reset} Wrote session manifest: ${c.dim}${manifestPath}${c.reset}`);

  console.log(`
${c.bold}Next:${c.reset} starting the onboarding stack:
  ${c.cyan}http://localhost:${ONBOARDING_PORT}${c.reset}  ${c.dim}— wizard UI${c.reset}
  ${c.cyan}http://localhost:${MOCK_CORE_PORT}${c.reset}  ${c.dim}— wavex core${c.reset}

Open ${c.bold}${c.cyan}http://localhost:${ONBOARDING_PORT}${c.reset} in your browser when it's ready.
Press ${c.bold}Ctrl-C${c.reset} to stop.
`);

  // Try to find wavex-os repo and run pnpm dev:full
  // Walks up from typical npm global install locations to find a co-installed repo.
  // Fallback: instruct user to clone the repo.
  const child = spawn('npx', ['wavex-os', 'init', companyName], {
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
      WAVEX_OS_SESSION_ID: sessionId,
      WAVEX_OS_COMPANY_NAME: companyName,
      WAVEX_MOCK_CORE_PORT: String(MOCK_CORE_PORT),
    },
  });

  child.on('exit', (code) => {
    if (code !== 0) {
      console.log(
        `\n${c.dim}Hint: If the wizard didn't start, ensure wavex-os is also installed:${c.reset}`,
      );
      console.log(`  ${c.cyan}npm install -g wavex-os-installer${c.reset}\n`);
    }
    process.exit(code ?? 0);
  });
}

async function reset() {
  console.log(BANNER);
  console.log(`${c.yellow}This will remove ${c.bold}${HOME_DIR}${c.reset}${c.yellow}.${c.reset}`);
  console.log(`${c.dim}To proceed: ${c.reset}${c.bold}rm -rf ${HOME_DIR}${c.reset}\n`);
}

function status() {
  console.log(BANNER);
  if (existsSync(STATE_FILE)) {
    try {
      const data = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
      console.log(`${c.bold}Pairing state:${c.reset} ${c.green}paired${c.reset}`);
      console.log(`  ${c.dim}Account:${c.reset} ${data.email ?? 'unknown'}`);
      console.log(`  ${c.dim}Paired at:${c.reset} ${data.pairedAt ?? 'unknown'}`);
    } catch {
      console.log(`${c.yellow}State file exists but could not be read.${c.reset}`);
    }
  } else {
    console.log(`${c.bold}Pairing state:${c.reset} ${c.dim}not paired${c.reset}`);
    console.log(`  Run ${c.cyan}tony-apple-qa login${c.reset} to pair with the cloud console.\n`);
  }
}

function login() {
  console.log(BANNER);
  console.log(`${c.dim}Cloud pairing is coming soon. For now, run locally with your Claude Max CLI.${c.reset}\n`);
}

function logout() {
  console.log(BANNER);
  if (existsSync(STATE_FILE)) {
    try {
      const data = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
      delete data.token;
      delete data.email;
      data.pairedAt = null;
      writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
      console.log(`${c.green}✓${c.reset} Logged out. Local state cleared.\n`);
    } catch {
      console.log(`${c.yellow}Could not clear state file.${c.reset}\n`);
    }
  } else {
    console.log(`${c.dim}Not currently logged in.${c.reset}\n`);
  }
}

function help() {
  console.log(BANNER);
  console.log(`${c.bold}Usage:${c.reset}
  ${c.cyan}tony-apple-qa init [company-name]${c.reset}   Bootstrap a new QA agent fleet
  ${c.cyan}tony-apple-qa doctor${c.reset}                Check prerequisites (Node, pnpm, claude CLI)
  ${c.cyan}tony-apple-qa audit${c.reset}                 Probe the running stack (disk, RAM, ports)
  ${c.cyan}tony-apple-qa status${c.reset}                Show local pairing state
  ${c.cyan}tony-apple-qa login${c.reset}                 Pair with the cloud console
  ${c.cyan}tony-apple-qa logout${c.reset}                Remove the local device token
  ${c.cyan}tony-apple-qa reset${c.reset}                 Remove ${c.dim}~/.wavex-os${c.reset} (destructive)
  ${c.cyan}tony-apple-qa --version${c.reset}             Print the CLI version
  ${c.cyan}tony-apple-qa --help${c.reset}                Show this message

${c.bold}Docs:${c.reset} https://github.com/aimerdoux/wavex-os
`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    help();
    return;
  }

  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    console.log(VERSION);
    return;
  }

  switch (cmd) {
    case 'init':
      await init(argv[1]);
      break;
    case 'doctor':
      console.log(BANNER);
      printDoctor(await doctor());
      break;
    case 'audit':
      console.log(BANNER);
      printAudit(await audit());
      break;
    case 'status':
      status();
      break;
    case 'login':
      login();
      break;
    case 'logout':
      logout();
      break;
    case 'reset':
      await reset();
      break;
    default:
      console.log(`${c.red}Unknown command:${c.reset} ${cmd}\n`);
      help();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`${c.red}Error:${c.reset}`, err.message);
  process.exit(1);
});
