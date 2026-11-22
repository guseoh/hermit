// PowerShell 스크립트 검사. Windows PowerShell 5.1은 BOM이 없는 UTF-8 파일의 한글을 잘못 읽으므로 BOM을 확인하고,
// 5.1 파서로 구문 오류가 없는지 확인한다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const scripts = fs.readdirSync(root).filter(name => name.endsWith('.ps1'));
const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const windows = process.platform === 'win32' && fs.existsSync(powershell);

test('모든 .ps1 파일이 UTF-8 BOM으로 시작한다', () => {
  assert.ok(scripts.length > 0);
  for (const name of scripts) {
    const head = fs.readFileSync(path.join(root, name)).subarray(0, 3);
    assert.deepEqual([...head], [0xef, 0xbb, 0xbf], name + '에 BOM이 없습니다');
  }
});

test('Windows PowerShell 5.1 파서에서 구문 오류가 없다', { skip: !windows && 'Windows PowerShell 5.1이 없습니다' }, () => {
  // 파일 목록은 환경 변수로 넘긴다. -Command 뒤에 경로를 붙이면 스크립트가 실행되어 버린다.
  const command = '$ErrorActionPreference = "Stop"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; ' +
    'foreach ($file in $env:WORKBENCH_TEST_SCRIPTS -split "\\|") { $errors = $null; ' +
    '[void][System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$null, [ref]$errors); ' +
    'foreach ($e in $errors) { "{0}:{1}: {2}" -f (Split-Path $file -Leaf), $e.Extent.StartLineNumber, $e.Message } }';
  const output = execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, WORKBENCH_TEST_SCRIPTS: scripts.map(name => path.join(root, name)).join('|') }
  });
  assert.equal(output.trim(), '', output);
});

test('앱이 스크립트를 실행하는 PowerShell에는 -ExecutionPolicy Bypass가 붙는다', () => {
  const read = file => fs.readFileSync(path.join(root, file), 'utf8');
  // 터미널: 인자 배열을 만든 뒤 -File prompt.ps1을 붙인다.
  assert.match(read('main.cjs'), /const args = \['-NoLogo', '-ExecutionPolicy', 'Bypass'\];/);
  // 에이전트 확인·Codex 서버: 한 줄짜리 인자 배열에 -File이 있다.
  const lines = read('agent.cjs').split('\n').filter(line => line.includes("'-File'"));
  assert.equal(lines.length, 2);
  for (const line of lines) assert.match(line, /'-ExecutionPolicy', 'Bypass', '-File'/, line.trim());
});
