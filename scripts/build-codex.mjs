#!/usr/bin/env node
/**
 * build-codex.js
 *
 * 构建 vendor 的 codex-rs 组件, 输出到 SGA 可识别的探测路径之一。
 *
 * 用法:
 *   node scripts/build-codex.js            # 默认 release 模式
 *   node scripts/build-codex.js --debug    # debug 模式
 *   node scripts/build-codex.js --app-server # 只构建 app-server (SGA 集成用)
 *
 * 产物路径:
 *   sga_template/codex-rs/target/release/codex-app-server(.exe)
 *
 * 这是 SGA 5 级探测路径之一 (`./codex-rs/target/release/...`),
 * 不需要额外配置即可被 sga_template/src/agents/codex/detect.ts 找到。
 */

import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 项目根目录
const projectRoot = resolve(__dirname, '..');
const codexRsDir = resolve(projectRoot, 'sga_template/codex-rs');

// 解析参数
const args = process.argv.slice(2);
const isDebug = args.includes('--debug');
const appServerOnly = args.includes('--app-server');
const profile = isDebug ? 'debug' : 'release';
const targetDir = resolve(codexRsDir, `target/${profile}`);

// 1. 检查 cargo
function checkCargo() {
  try {
    const version = execSync('cargo --version', { encoding: 'utf-8' });
    console.log(`✓ Found: ${version.trim()}`);
    return true;
  } catch {
    console.error('✗ cargo (Rust) not found.');
    console.error('  Install Rust from https://rustup.rs/');
    console.error('  On Windows: winget install Rustlang.Rustup');
    process.exit(1);
  }
}

// 2. 检查 vendor 目录
function checkVendor() {
  if (!existsSync(codexRsDir)) {
    console.error(`✗ Vendor directory not found: ${codexRsDir}`);
    console.error('  Run: curl -L https://codeload.github.com/openai/codex/tar.gz/refs/heads/main -o /tmp/codex.tar.gz');
    console.error('       tar -xzf /tmp/codex.tar.gz -C /tmp/');
    console.error('       mv /tmp/codex-main/codex-rs sga_template/codex-rs');
    process.exit(1);
  }
  if (!existsSync(resolve(codexRsDir, 'Cargo.toml'))) {
    console.error(`✗ Cargo.toml not found in ${codexRsDir}`);
    process.exit(1);
  }
  console.log(`✓ Vendor directory: ${codexRsDir}`);
}

// 3. 构建
function build() {
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  const cargoArgs = ['build', `--${profile}`];
  if (appServerOnly) {
    cargoArgs.push('-p', 'codex-app-server');
  } else {
    cargoArgs.push('-p', 'codex-app-server', '-p', 'codex-cli');
  }

  console.log(`\n→ cargo ${cargoArgs.join(' ')}\n`);

  const proc = spawn('cargo', cargoArgs, {
    cwd: codexRsDir,
    stdio: 'inherit',
    env: { ...process.env, CARGO_TERM_COLOR: 'always' },
  });

  proc.on('exit', (code) => {
    if (code === 0) {
      const ext = process.platform === 'win32' ? '.exe' : '';
      const binary = resolve(targetDir, `codex-app-server${ext}`);
      if (existsSync(binary)) {
        console.log(`\n✓ Build succeeded: ${binary}`);
        console.log(`\n  SGA will auto-detect this binary (5th level probe path).`);
        console.log(`  To verify, run:`);
        console.log(`    curl http://127.0.0.1:8000/api/codex/status`);
      } else {
        console.log(`\n✓ Build succeeded but binary not found at expected path.`);
      }
    } else {
      console.error(`\n✗ Build failed with exit code ${code}`);
      process.exit(code ?? 1);
    }
  });
}

console.log('=== Codex Build Script ===\n');
checkVendor();
checkCargo();
build();
