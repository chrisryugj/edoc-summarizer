// kordoc 로컬 헬퍼 서버 — 확장의 첨부파일 변환·표기법 검수를 kordoc CLI에 위임한다.
//
//   node scripts/kordoc-helper.mjs          (기본 http://127.0.0.1:8531)
//   설치·자동시작 등록: scripts/setup-kordoc-helper.ps1
//
// 엔드포인트:
//   GET  /health                → { ok, kordoc: <버전> }
//   POST /extract?name=<파일명> → 바디(원본 바이트)를 임시파일로 저장, kordoc 변환 → { text }
//   POST /lint                  → 바디(UTF-8 텍스트)를 kordoc lint --json → findings JSON 그대로
//
// 보안: 127.0.0.1 바인딩 + CORS 헤더 없음 — 웹페이지의 fetch는 CORS로 차단되고,
// 호스트 권한을 가진 이 확장의 서비스워커만 호출할 수 있다. 파일은 임시폴더에서 변환 후 즉시 삭제.
import http from 'node:http';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT = +(process.env.KORDOC_HELPER_PORT || 8531);
const MAX_BODY = 25 * 1024 * 1024;
const EXT_OK = new Set(['hwp', 'hwpx', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf', 'txt', 'csv']);
// Windows에서 npm 글로벌 CLI는 kordoc.cmd — execFile은 .cmd를 직접 못 돌리므로 cmd /c 로 감싼다
const runKordoc = (args, timeout = 90000) => new Promise((resolve) => {
  const [cmd, pre] = process.platform === 'win32' ? ['cmd.exe', ['/c', 'kordoc']] : ['kordoc', []];
  execFile(cmd, [...pre, ...args], { timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
    (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) { reject(new Error('too big')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
};

let kordocVersion = '';

async function extract(req, res, url) {
  const name = url.searchParams.get('name') || '';
  const ext = (/\.([a-z0-9]{1,5})$/i.exec(name)?.[1] || '').toLowerCase();
  if (!EXT_OK.has(ext)) return json(res, 400, { error: `미지원 확장자: ${ext || '(없음)'}` });
  const body = await readBody(req);
  if (!body.length) return json(res, 400, { error: '빈 요청' });
  // 파일명은 신뢰하지 않는다 — 요청별 임시폴더에 무작위 이름으로 쓰고 확장자만 살린다.
  // kordoc이 추출 이미지를 출력 옆에 저장하므로 폴더째 만들고 폴더째 지운다.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'edoc-'));
  const inFile = path.join(dir, `in.${ext}`);
  const outFile = path.join(dir, 'out.md');
  try {
    await fs.writeFile(inFile, body);
    const r = await runKordoc([inFile, '-o', outFile, '--silent']);
    const text = await fs.readFile(outFile, 'utf8').catch(() => '');
    if (!text.trim()) {
      return json(res, 422, { error: (r.stderr || r.err?.message || '변환 실패').slice(0, 300) });
    }
    json(res, 200, { text });
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function lint(req, res) {
  const body = await readBody(req);
  const inFile = path.join(os.tmpdir(), `edoc-${crypto.randomBytes(8).toString('hex')}.txt`);
  try {
    await fs.writeFile(inFile, body);
    // findings가 있으면 exit 1 이지만 stdout JSON은 정상 — 종료코드는 무시하고 출력만 본다
    const r = await runKordoc(['lint', inFile, '--json'], 30000);
    try {
      json(res, 200, JSON.parse(r.stdout));
    } catch {
      json(res, 422, { error: (r.stderr || 'lint 출력 해석 실패').slice(0, 300) });
    }
  } finally {
    fs.unlink(inFile).catch(() => {});
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, kordoc: kordocVersion });
    if (req.method === 'POST' && url.pathname === '/extract') return await extract(req, res, url);
    if (req.method === 'POST' && url.pathname === '/lint') return await lint(req, res);
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: String(e.message || e).slice(0, 300) });
  }
});

const { stdout } = await runKordoc(['-V'], 15000);
kordocVersion = stdout.trim();
if (!kordocVersion) {
  console.error('kordoc CLI를 찾을 수 없습니다 — npm i -g kordoc 후 다시 실행하세요.');
  process.exit(1);
}
server.listen(PORT, '127.0.0.1', () => {
  console.log(`kordoc 헬퍼 대기 중 — http://127.0.0.1:${PORT} (kordoc ${kordocVersion})`);
});
