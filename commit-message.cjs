// staged diff로 커밋 메시지를 만든다. 작업의 에이전트 CLI를 한 번만 실행하고, 도구는 쓰지 못하게 한다.
//  - Claude Code: claude -p --tools "" (도구 없음, 세션 저장 안 함)
//  - Codex: codex exec --sandbox read-only --ephemeral, 마지막 답변만 파일로 받는다.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function buildPrompt(context) {
  return [
    '아래 staged 변경에 맞는 Git 커밋 메시지를 작성하라.',
    '- 최근 커밋 제목과 같은 언어와 형식을 따른다. 최근 커밋이 없으면 한국어로 쓴다.',
    '- 첫 줄은 72자 이하 제목, 마침표 없이. 변경이 여러 갈래면 빈 줄 뒤에 "- "로 시작하는 본문을 3~6줄 쓴다.',
    '- 커밋 메시지만 출력한다. 설명, 따옴표, 코드 블록, 머리말은 쓰지 않는다.',
    '- 파일을 읽거나 명령을 실행하지 말고 아래 내용만 보고 쓴다.',
    '',
    '## 브랜치', context.branch || '(알 수 없음)',
    '', '## 최근 커밋 제목', context.recent || '(없음)',
    '', '## 변경 요약', context.stat.trim(),
    '', '## diff' + (context.truncated ? ' (길어서 앞부분만)' : ''), context.diff
  ].join('\n');
}

// 모델이 코드 블록이나 머리말을 붙여도 메시지만 남긴다.
function clean(text) {
  let message = String(text ?? '').replace(/\r\n/g, '\n').trim();
  const fenced = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(message);
  if (fenced) message = fenced[1].trim();
  message = message.replace(/^(?:커밋 메시지|commit message)\s*[:：]\s*/i, '').trim();
  if (/^["'“].*["'”]$/s.test(message) && !message.includes('\n')) message = message.slice(1, -1).trim();
  return message;
}

function run(command, args, { cwd, input, env, timeout = 120000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('AI 응답 시간이 초과되었습니다.')); }, timeout);
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-200000); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(Object.assign(new Error('AI 실행 실패 (' + code + ')'), { stderr }));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// prompt·finish를 주면 같은 방식(도구 없이 한 번 실행)으로 다른 글(PR 초안 등)을 만든다.
async function generate({ provider, file, command, args = [], context, prompt = buildPrompt(context), finish = clean }) {
  const env = { ...process.env };
  let output;
  if (provider === 'claude') {
    output = await run(file, ['-p', '--output-format', 'text', '--tools', '', '--no-session-persistence'],
      { cwd: context.root, input: prompt, env });
  } else if (provider === 'codex') {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-commit-'));
    const last = path.join(directory, 'message.txt');
    try {
      if (command === process.execPath) env.ELECTRON_RUN_AS_NODE = '1';
      await run(command, [...args, 'exec', '--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check',
        '--color', 'never', '--output-last-message', last, '-'], { cwd: context.root, input: prompt, env, timeout: 180000 });
      output = await fs.readFile(last, 'utf8');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  } else throw new Error('알 수 없는 에이전트입니다.');
  const message = finish(output);
  if (!message) throw new Error('AI가 빈 메시지를 돌려주었습니다.');
  return message;
}

// PR 제목·본문 초안: 기준 브랜치 이후 커밋과 변경으로 쓴다. 첫 줄은 제목, 빈 줄 뒤는 Markdown 본문.
function buildPullRequestPrompt(context) {
  return [
    '아래 브랜치의 Pull Request 제목과 본문을 작성하라.',
    '- 커밋 메시지와 같은 언어로 쓴다. 커밋이 없으면 한국어로 쓴다.',
    '- 첫 줄은 72자 이하 제목, 마침표 없이. 그다음 빈 줄, 그 뒤가 본문이다.',
    '- 본문은 Markdown으로 "## 변경 사항"(핵심 변경 3~8개 글머리)과 "## 확인 방법"(검증 방법)을 쓴다. 근거 없는 내용은 지어내지 않는다.',
    '- 제목과 본문만 출력한다. 머리말이나 전체를 감싸는 코드 블록은 쓰지 않는다.',
    '- 파일을 읽거나 명령을 실행하지 말고 아래 내용만 보고 쓴다.',
    '',
    '## 브랜치', context.branch + ' → ' + context.base,
    '', '## 커밋', context.log || '(없음)',
    '', '## 변경 요약', context.stat.trim() || '(없음)',
    '', '## diff' + (context.truncated ? ' (길어서 앞부분만)' : ''), context.diff
  ].join('\n');
}

function parsePullRequestDraft(text) {
  const cleaned = clean(text).replace(/^(?:제목|title)\s*[:：]\s*/i, '');
  const [first, ...rest] = cleaned.split('\n');
  const title = first.replace(/^#+\s*/, '').trim().slice(0, 256);
  const body = rest.join('\n').replace(/^\s*(?:본문|body)\s*[:：]\s*/i, '').trim();
  return title ? { title, body } : null;
}

module.exports = { generate, buildPrompt, clean, buildPullRequestPrompt, parsePullRequestDraft };
