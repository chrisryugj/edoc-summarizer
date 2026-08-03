// LLM 프로바이더 추상화.
// 기본은 로컬(OpenAI 호환 — Ollama/vLLM). provider를 'gemini'로 바꾸면 외부 API를 쓴다.
// opts.onPartial을 주면 SSE 스트리밍으로 호출하고, 누적 응답을 부분 파싱한 결과 객체를 계속 넘겨준다.
// opts.signal로 진행 중 요청을 취소할 수 있다.

import {
  SYSTEM_PROMPT, REVIEW_PROMPT, DOC_OPEN, DOC_CLOSE, REVIEW_STATUSES, STATUS_UNKNOWN,
} from './prompts.js';

// ── 공통: 타임아웃·에러 매핑 ──
const IDLE_MS = 30000;   // 스트리밍 청크 간 최대 대기
const HARD_MS = 120000;  // 요청 전체 최대 시간 (연결 수립 포함)

// 응답 본문(detail)은 사용자 화면에 싣지 않는다 — 서버가 요청 헤더·내부 경로를 에코하는
// 구성이면 그대로 노출되기 때문. 상세는 서비스워커 콘솔에만 남긴다.
// hasKey=false(키 없이 쓰는 내부 LLM)면 401/403은 키 문제일 수 없다.
// Ollama는 OLLAMA_ORIGINS 허용목록에 없는 오리진(chrome-extension://…)을 403으로 끊는다 —
// 이걸 "API 키가 틀렸다"고 안내하면 키 칸이 빈 사용자가 고칠 수 없는 메시지가 된다.
function apiError(status, body = '', { hasKey = true } = {}) {
  const detail = String(body).slice(0, 500);
  if (detail) console.warn(`[edoc] LLM API ${status}:`, detail);
  if (!hasKey && status === 403) {
    const id = chrome.runtime?.id;
    return new Error(
      `LLM 서버가 이 확장의 접근을 거부했습니다(403). Ollama라면 OLLAMA_ORIGINS에 `
      + `chrome-extension://${id || '<확장ID>'} 를 추가하고 Ollama를 완전히 종료 후 다시 실행하세요.`
    );
  }
  if (!hasKey && status === 401) {
    return new Error('LLM 서버가 인증을 요구합니다(401) — ⚙ 설정에서 API 키를 입력하세요.');
  }
  if (status === 401 || status === 403 || (status === 400 && /api.?key/i.test(detail))) {
    return new Error('API 키가 올바르지 않습니다 — ⚙ 설정에서 확인하세요.');
  }
  if (status === 429) return new Error('요청이 많아 잠시 제한되었습니다(429). 잠시 후 다시 시도하세요.');
  if (status === 408 || status >= 500) return new Error(`AI 서비스가 원활하지 않습니다(${status}). 잠시 후 다시 시도하세요.`);
  return new Error(`LLM 요청이 거부되었습니다 (HTTP ${status}). 자세한 내용은 확장 서비스워커 콘솔을 확인하세요.`);
}

// fetch 자체 실패(서버 미기동, 내부망 밖 등)·중단을 사용자 언어로
function fetchError(e) {
  if (e?.name === 'TimeoutError') return new Error('AI 응답이 제한 시간(2분)을 넘겼습니다. 서버 상태를 확인하세요.');
  if (e?.name === 'AbortError') return Object.assign(new Error('요청이 취소되었습니다.'), { cancelled: true });
  if (e instanceof TypeError) return new Error('LLM 서버에 연결할 수 없습니다 — 주소와 네트워크(내부망/VPN)를 확인하세요.');
  return e;
}

// 응답이 중간에 끊긴 경우(토큰 한도·안전 필터)를 정상 완료로 착각하지 않게 매핑
function truncationError(reason) {
  const r = String(reason || '').toUpperCase();
  if (r === 'LENGTH' || r === 'MAX_TOKENS') {
    return new Error('문서가 길어 AI 응답이 중간에 잘렸습니다. 본문 일부만 선택해 다시 시도하세요.');
  }
  if (r === 'SAFETY' || r === 'BLOCKLIST' || r === 'PROHIBITED_CONTENT' || r === 'RECITATION') {
    return new Error(`AI 안전 필터가 응답을 차단했습니다(${r}). 로컬 LLM 사용을 검토하세요.`);
  }
  return null;
}

// 외부 취소 신호와 전체 제한시간을 하나로 합친다 (연결 수립 전 단계까지 커버).
function withTimeout(signal) {
  const timer = AbortSignal.timeout(HARD_MS);
  return signal ? AbortSignal.any([signal, timer]) : timer;
}

export async function summarize(text, config, opts = {}) {
  return requestLlm(text, config, 'summary', opts);
}

export async function review(text, config, opts = {}) {
  return requestLlm(text, config, 'review', opts);
}

async function requestLlm(text, config, mode, { onPartial, signal } = {}) {
  const sys = mode === 'review' ? REVIEW_PROMPT : SYSTEM_PROMPT;
  // 원문에 구분자와 같은 문자열이 들어 있으면 감싸기가 깨지므로 무력화한 뒤 넣는다.
  const safe = String(text || '').split(DOC_OPEN).join('<<<>>>').split(DOC_CLOSE).join('<<<>>>');
  const wrapped = `${DOC_OPEN}\n${safe}\n${DOC_CLOSE}`;
  const onAccum = onPartial ? (acc) => { try { onPartial(parsePartial(acc, mode)); } catch { /* 렌더 실패는 무시 */ } } : null;
  const provider = config.provider === 'gemini' ? 'gemini' : 'openai';
  let raw;
  try {
    raw = provider === 'gemini'
      ? await callGemini(wrapped, config, sys, onAccum, signal)
      : await callOpenAI(wrapped, config, sys, onAccum, signal);
  } catch (e) {
    throw fetchError(e);
  }
  return mode === 'review' ? parseReview(raw) : parseResult(raw);
}

async function callGemini(text, config, sys, onAccum, signal) {
  const model = config.model || 'gemini-flash-latest';
  const method = onAccum ? 'streamGenerateContent?alt=sse' : 'generateContent';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': config.apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: sys }] },
      contents: [{ role: 'user', parts: [{ text }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
      },
    }),
    signal: withTimeout(signal),
  });
  if (!res.ok) throw apiError(res.status, await res.text(), { hasKey: !!config.apiKey });

  const checkBlocked = (data) => {
    const blocked = data?.promptFeedback?.blockReason;
    if (blocked) throw new Error(`AI 안전 필터가 요청을 차단했습니다(${blocked}). 로컬 LLM 사용을 검토하세요.`);
  };

  if (!onAccum) {
    const data = await res.json();
    checkBlocked(data);
    const cand = data.candidates?.[0];
    const raw = cand?.content?.parts?.map((p) => p.text || '').join('');
    const trunc = truncationError(cand?.finishReason);
    if (trunc && !raw) throw trunc;
    if (!raw) throw new Error('Gemini 응답에 텍스트가 없습니다.');
    if (trunc) throw trunc;
    return raw;
  }

  let acc = '';
  let finish = '';
  await readSse(res, (data) => {
    checkBlocked(data);
    const cand = data.candidates?.[0];
    if (cand?.finishReason) finish = cand.finishReason;
    const t = cand?.content?.parts?.map((p) => p.text || '').join('') || '';
    if (t) { acc += t; onAccum(acc); }
  });
  const trunc = truncationError(finish);
  if (trunc) throw trunc;
  if (!acc) throw new Error('Gemini 스트리밍 응답이 비어 있습니다.');
  return acc;
}

async function callOpenAI(text, config, sys, onAccum, signal) {
  // baseUrl 미설정 시 로컬 Ollama 기본값
  const base = (config.baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
  const payload = {
    model: config.model || 'gemma4:e4b', // 로컬 Ollama 기본값
    temperature: 0.2,
    max_tokens: 2000, // 소형 모델 출력 폭주 방지
    // 씽킹 모델(qwen3.5 등)은 사고 토큰이 max_tokens를 다 먹고 content가 비어버림 — 사고 비활성화.
    // reasoning_effort는 Ollama·OpenAI 계열, chat_template_kwargs는 vLLM 계열이 인식. 미지원 서버는 400 재시도로 제거.
    reasoning_effort: 'none',
    chat_template_kwargs: { enable_thinking: false },
    response_format: { type: 'json_object' },
    stream: !!onAccum,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: text },
    ],
  };
  const call = (body) =>
    fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: withTimeout(signal),
    });
  const ctx = { hasKey: !!config.apiKey };
  let res = await call(payload);
  if (res.status === 400) {
    // 일부 서버는 response_format·reasoning_effort·chat_template_kwargs 미지원 — 빼고 재시도 (프롬프트가 JSON을 강제함)
    const { response_format, reasoning_effort, chat_template_kwargs, ...rest } = payload;
    res = await call(rest);
  }
  if (!res.ok) throw apiError(res.status, await res.text(), ctx);

  if (!onAccum) {
    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content;
    const trunc = truncationError(data.choices?.[0]?.finish_reason);
    if (!raw) throw trunc || new Error('LLM 응답에 텍스트가 없습니다.');
    if (trunc) throw trunc;
    return raw;
  }

  // 스트리밍 요청인데 SSE가 아닌 응답: 스트리밍 미지원 서버의 일반 JSON이거나 오류 본문
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  if (!ctype.includes('text/event-stream')) {
    const data = await res.json().catch(() => null);
    const raw = data?.choices?.[0]?.message?.content;
    if (raw) { onAccum(raw); return raw; }
    throw new Error(data?.error?.message || '스트리밍 응답 형식을 지원하지 않는 서버입니다.');
  }

  let acc = '';
  let finish = '';
  await readSse(res, (data) => {
    if (data.error) throw apiError(Number(data.error.code) || 0, data.error.message || JSON.stringify(data.error), ctx);
    const ch = data.choices?.[0];
    if (ch?.finish_reason) finish = ch.finish_reason;
    const t = ch?.delta?.content ?? '';
    if (t) { acc += t; onAccum(acc); }
  });
  const trunc = truncationError(finish);
  if (trunc) throw trunc;
  if (!acc) throw new Error('LLM 스트리밍 응답이 비어 있습니다.');
  return acc;
}

// SSE(text/event-stream) 본문을 읽어 data: JSON마다 onData 호출.
// 청크 간 IDLE_MS 유휴 타임아웃 — 전체 제한시간은 fetch signal이 담당한다.
async function readSse(res, onData) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const flush = (block) => {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('\n');
    if (!data) return false;
    if (data === '[DONE]') return true;
    let json;
    try { json = JSON.parse(data); } catch { return false; }
    onData(json);
    return false;
  };
  try {
    while (true) {
      let timer;
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise((_, rej) => {
          timer = setTimeout(
            () => rej(new Error('AI 응답 스트림이 30초간 멈췄습니다. 잠시 후 다시 시도하세요.')),
            IDLE_MS
          );
        }),
      ]).finally(() => clearTimeout(timer));
      buf += dec.decode(value || new Uint8Array(), { stream: !done });
      const blocks = buf.split(/\r?\n\r?\n/);
      buf = blocks.pop() ?? '';
      for (const block of blocks) {
        if (flush(block)) return;
      }
      if (done) {
        // 빈 줄 없이 EOF하는 비표준 서버 대비 — 남은 버퍼의 마지막 이벤트를 버리지 않는다
        if (buf.trim()) flush(buf);
        return;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

// ── 응답 파싱 ──

const stripFences = (raw) => String(raw ?? '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

// JSON 본체만 남기기 — response_format 미지원 서버에서 모델이 앞말을 붙이는 경우 구제
const fromFirstBrace = (s) => {
  const i = s.indexOf('{');
  return i > 0 ? s.slice(i) : s;
};

const asText = (v) => (v == null || typeof v === 'object' ? '' : String(v)).trim();
// 모델이 배열 대신 문자열 하나를 주는 경우가 잦다 — 렌더 쪽에서 .map이 터지지 않게 정규화
const asList = (v) => {
  if (Array.isArray(v)) return v.map(asText).filter(Boolean);
  const s = asText(v);
  return s ? [s] : [];
};

function parseResult(raw) {
  const stripped = fromFirstBrace(stripFences(raw));
  try {
    const r = JSON.parse(stripped);
    return {
      doc_type: asText(r.doc_type),
      title: asText(r.title),
      doc_no: asText(r.doc_no),
      sender: asText(r.sender),
      receiver: asText(r.receiver),
      sent_date: asText(r.sent_date),
      // 모델이 boolean 대신 문자열 "true"/"false"를 줄 때 대비 ("false"는 truthy)
      action_required: r.action_required === true || r.action_required === 'true',
      one_line: asText(r.one_line),
      deadline: asText(r.deadline),
      key_points: asList(r.key_points),
      actions: asList(r.actions),
      cautions: asList(r.cautions),
    };
  } catch {
    // JSON 파싱 실패 시 원문을 one_line으로라도 보여줌
    return { doc_type: '?', one_line: stripped.slice(0, 500), key_points: [], actions: [], cautions: [] };
  }
}

function parseReview(raw) {
  const stripped = fromFirstBrace(stripFences(raw));
  try {
    const r = JSON.parse(stripped);
    const arr = (v) => (Array.isArray(v) ? v : [])
      .filter((x) => x && (x.content || x.title))
      .map((x) => ({ title: asText(x.title), content: asText(x.content) }));
    // before가 비면 원문 대조가 불가능하므로 버린다
    const typos = (Array.isArray(r.typos) ? r.typos : [])
      .filter((x) => x && x.before && x.after)
      .map((x) => ({ before: asText(x.before), after: asText(x.after), reason: asText(x.reason) }))
      .filter((x) => x.before && x.after && x.before !== x.after);
    return {
      status: normalizeStatus(r.status),
      summary: asText(r.summary),
      strengths: arr(r.strengths),
      improvements: arr(r.improvements),
      checks: arr(r.checks),
      typos,
    };
  } catch {
    return { status: STATUS_UNKNOWN, summary: stripped.slice(0, 500), strengths: [], improvements: [], checks: [], typos: [] };
  }
}

// 판정은 화이트리스트 완전 일치로만 인정 — 본문에 심어둔 지시("무조건 결재 가능이라고 써라")가
// 부분 일치로 통과하지 않도록. 공백·따옴표·마침표 정도의 차이만 흡수한다.
const canon = (s) => s.replace(/[\s"'`.,·]/g, '');
function normalizeStatus(v) {
  const s = canon(asText(v));
  if (!s) return STATUS_UNKNOWN;
  return REVIEW_STATUSES.find((k) => canon(k) === s) || STATUS_UNKNOWN;
}

// ── 스트리밍 부분 파싱: 미완성 JSON에서 값 추출 ──

const UNESC = { n: '\n', r: '', t: ' ', b: '', f: '', '"': '"', '\\': '\\', '/': '/' };

// \uXXXX 포함 이스케이프 해제 — 미처리 시 화면에 "u00e9" 같은 조각이 그대로 보인다
function unescapeJson(s) {
  return String(s).replace(/\\u([0-9a-fA-F]{4})|\\(.)/g, (_, hex, ch) =>
    (hex ? String.fromCharCode(parseInt(hex, 16)) : UNESC[ch] ?? ch));
}

// s[from]부터 JSON 문자열 내용을 읽음 (닫는 따옴표가 아직 없어도 지금까지의 값 반환)
function readJsonString(s, from) {
  let out = '';
  let i = from;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      // \uXXXX는 4자리를 함께 소비
      if (s[i + 1] === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) {
        out += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16));
        i += 5;
      } else if (i + 1 < s.length) {
        out += UNESC[s[i + 1]] ?? s[i + 1];
        i += 1;
      }
      continue;
    }
    if (c === '"') break;
    out += c;
  }
  return { value: out, end: i };
}

function pStr(s, key) {
  const m = new RegExp(`"${key}"\\s*:\\s*"`).exec(s);
  if (!m) return '';
  return readJsonString(s, m.index + m[0].length).value.trim();
}

// 배열 리터럴의 끝 ']'을 문자열 내부를 건너뛰며 찾는다.
// 단순 indexOf(']')로 자르면 content에 "[붙임]" 같은 대괄호가 있을 때 뒤 항목이 통째로 잘린다.
function sliceArrayBody(s, from) {
  let i = from;
  let depth = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') { i = readJsonString(s, i + 1).end + 1; continue; }
    if (c === '[' || c === '{') { depth++; i++; continue; }
    if (c === '}') { depth--; i++; continue; }
    if (c === ']') {
      if (depth === 0) return s.slice(from, i);
      depth--; i++; continue;
    }
    i++;
  }
  return s.slice(from);
}

function pArr(s, key, max = 12) {
  const m = new RegExp(`"${key}"\\s*:\\s*\\[`).exec(s);
  if (!m) return [];
  const seg = sliceArrayBody(s, m.index + m[0].length);
  const out = [];
  let i = 0;
  while (i < seg.length && out.length < max) {
    if (seg[i] === '"') {
      const r = readJsonString(seg, i + 1);
      if (r.value.trim()) out.push(r.value.trim());
      i = r.end + 1;
      continue;
    }
    i++;
  }
  return out;
}

// {"title":"...","content":"..."} 객체 배열 — 완성된 객체만 수집 (스트리밍 중 잘린 꼬리는 다음 틱에서)
function pObjArr(s, key) {
  const m = new RegExp(`"${key}"\\s*:\\s*\\[`).exec(s);
  if (!m) return [];
  const seg = sliceArrayBody(s, m.index + m[0].length);
  const out = [];
  const re = /\{\s*"title"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"content"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
  let mm;
  while ((mm = re.exec(seg))) {
    out.push({ title: unescapeJson(mm[1]).trim(), content: unescapeJson(mm[2]).trim() });
  }
  return out;
}

// {"before":"...","after":"...","reason":"..."} 배열 — reason은 선택
function pTypoArr(s) {
  const m = /"typos"\s*:\s*\[/.exec(s);
  if (!m) return [];
  const seg = sliceArrayBody(s, m.index + m[0].length);
  const out = [];
  const re = /\{\s*"before"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"after"\s*:\s*"((?:[^"\\]|\\.)*)"(?:\s*,\s*"reason"\s*:\s*"((?:[^"\\]|\\.)*)")?\s*\}/g;
  let mm;
  while ((mm = re.exec(seg))) {
    out.push({
      before: unescapeJson(mm[1]).trim(),
      after: unescapeJson(mm[2]).trim(),
      reason: unescapeJson(mm[3] || '').trim(),
    });
  }
  return out.filter((t) => t.before && t.after && t.before !== t.after);
}

function parsePartial(acc, mode) {
  const s = stripFences(acc);
  if (mode === 'review') {
    return {
      __partial: true,
      // 스트리밍 중에는 아직 미완성 문자열이라 화이트리스트를 통과 못 할 수 있다 —
      // 부분 일치하는 접두사까지만 보여주고, 최종 판정은 parseReview가 확정한다.
      status: partialStatus(pStr(s, 'status')),
      summary: pStr(s, 'summary'),
      strengths: pObjArr(s, 'strengths'),
      improvements: pObjArr(s, 'improvements'),
      checks: pObjArr(s, 'checks'),
      typos: pTypoArr(s),
    };
  }
  return {
    __partial: true,
    doc_type: pStr(s, 'doc_type'),
    title: pStr(s, 'title'),
    doc_no: pStr(s, 'doc_no'),
    sender: pStr(s, 'sender'),
    receiver: pStr(s, 'receiver'),
    sent_date: pStr(s, 'sent_date'),
    action_required: /"action_required"\s*:\s*(true|"true")/.test(s),
    one_line: pStr(s, 'one_line'),
    deadline: pStr(s, 'deadline'),
    key_points: pArr(s, 'key_points'),
    actions: pArr(s, 'actions'),
    cautions: pArr(s, 'cautions'),
  };
}

// 스트리밍 중에는 아직 글자가 다 오지 않았으므로 정식 판정의 접두사까지만 그대로 보여준다.
// (그 외 문자열은 최종 확정 전까지 "판정 불가"로 둔다.)
function partialStatus(s) {
  if (!s) return '';
  return REVIEW_STATUSES.some((k) => k.startsWith(s)) ? s : STATUS_UNKNOWN;
}

// ── 옵션 페이지 연결 테스트: 모델 목록 + 초소형 실호출로 왕복 확인 ──
export async function testConnection(config) {
  const signal = () => AbortSignal.timeout(20000); // 설정 화면은 짧게 끊는다
  const ctx = { hasKey: !!config.apiKey };
  try {
    if (config.provider === 'gemini') {
      const model = config.model || 'gemini-flash-latest';
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: '응답은 OK 한 단어로만 하세요.' }] }] }),
        signal: signal(),
      });
      if (!res.ok) throw apiError(res.status, await res.text(), ctx);
      const t = ((await res.json()).candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
      return `연결 성공 (${model}${t ? ` → "${t.slice(0, 30)}"` : ''})`;
    }
    const base = (config.baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
    const auth = config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
    const mres = await fetch(`${base}/v1/models`, { headers: auth, signal: signal() });
    if (!mres.ok) throw apiError(mres.status, await mres.text(), ctx);
    const models = (((await mres.json()).data) || []).map((m) => m.id);
    const model = config.model || models[0];
    if (!model) throw new Error('서버에 설치된 모델이 없습니다.');
    const cres = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: '응답은 OK 한 단어로만 하세요.' }] }),
      signal: signal(),
    });
    if (!cres.ok) throw apiError(cres.status, await cres.text(), ctx);
    const t = ((await cres.json()).choices?.[0]?.message?.content || '').trim();
    return `연결 성공 — 설치 모델 ${models.length}개, ${model}${t ? ` → "${t.slice(0, 30)}"` : ''}`;
  } catch (e) {
    throw fetchError(e);
  }
}
