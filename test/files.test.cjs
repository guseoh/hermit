// 파일 탐색·검색(main/files.cjs) 테스트: 폴더 목록 정렬·무시 표시, 경로 가두기, rg·git grep 검색.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { listDirectory, searchText, findRipgrep } = require('../main/files.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-files-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(root, 'build'));
  fs.writeFileSync(path.join(root, '.gitignore'), 'build/\n*.log\n');
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'const Answer = 42;\nfunction login() { return "LOGIN"; }\n');
  fs.writeFileSync(path.join(root, 'src', 'deep', 'b.txt'), 'nothing\nlogin here\n');
  fs.writeFileSync(path.join(root, 'z.log'), 'login in log\n');
  fs.writeFileSync(path.join(root, 'build', 'out.js'), 'login build\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# 로그인\n');
  return root;
}

test('폴더 목록: 폴더 먼저, 이름순, Git 무시 항목 표시, 한 단계씩', async () => {
  const root = fixture();
  const top = await listDirectory(root);
  assert.deepEqual(top.entries.map(entry => [entry.name, entry.dir, entry.ignored]),
    [['build', true, true], ['src', true, false], ['.gitignore', false, false], ['README.md', false, false], ['z.log', false, true]]);
  const src = await listDirectory(root, 'src');
  assert.deepEqual(src.entries.map(entry => entry.path), ['src/deep', 'src/app.js']);
  assert.equal(src.path, 'src');
});

test('작업 폴더 밖이나 .git은 열지 않는다', async () => {
  const root = fixture();
  await assert.rejects(listDirectory(root, '..'), /밖의 경로/);
  await assert.rejects(listDirectory(root, 'src/../../'), /밖의 경로/);
  await assert.rejects(listDirectory(root, '.git'), /\.git/);
});

test('git grep 검색: 대소문자 무시가 기본, 무시된 파일은 빼고, 정규식은 켤 때만', async () => {
  const root = fixture();
  const found = await searchText(root, 'login', { engine: 'git' });
  assert.equal(found.engine, 'git');
  assert.deepEqual(found.matches.map(match => match.path + ':' + match.line).sort(), ['src/app.js:2', 'src/deep/b.txt:2']);
  const exact = await searchText(root, 'LOGIN', { engine: 'git', caseSensitive: true });
  assert.deepEqual(exact.matches.map(match => [match.path, match.column]), [['src/app.js', 28]]);
  assert.equal((await searchText(root, 'log.n here', { engine: 'git' })).matches.length, 0, '기본은 글자 그대로 찾는다');
  assert.equal((await searchText(root, 'log.n here', { engine: 'git', regex: true })).matches.length, 1);
  assert.deepEqual(await searchText(root, '   '), { engine: null, matches: [], truncated: false });
});

test('rg가 있으면 rg로 같은 결과를 낸다', { skip: !findRipgrep() && 'rg를 찾지 못함' }, async () => {
  const root = fixture();
  const found = await searchText(root, 'login');
  assert.equal(found.engine, 'rg');
  assert.deepEqual(found.matches.map(match => match.path + ':' + match.line + ':' + match.column).sort(), ['src/app.js:2:10', 'src/deep/b.txt:2:1']);
  assert.equal((await searchText(root, '로그인')).matches[0].path, 'README.md');
});

test('소스 탭용 읽기: 작업 폴더 안의 텍스트만', async () => {
  const { readText } = require('../main/files.cjs');
  const root = fixture();
  assert.deepEqual(await readText(root, 'src/app.js'), { path: 'src/app.js', text: 'const Answer = 42;\nfunction login() { return "LOGIN"; }\n' });
  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([1, 0, 2]));
  await assert.rejects(readText(root, 'bin.dat'), /바이너리/);
  await assert.rejects(readText(root, '../x'), /밖의 경로/);
  await assert.rejects(readText(root, 'src'), /텍스트 파일/);
});
