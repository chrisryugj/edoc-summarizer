// LLM 프로바이더 추상화.
// POC: Gemini API. 내부 LLM 전환 시 옵션에서 provider를 'openai'로 바꾸고
// baseUrl(내부 엔드포인트)만 지정하면 됨 — OpenAI 호환 API(vLLM, Ollama 등) 가정.
// opts.onPartial을 주면 SSE 스트리밍으로 호출하고, 누적 응답을 부분 파싱한 결과 객체를 계속 넘겨준다.

const SYSTEM_PROMPT = `당신은 한국 공공기관 전자문서 요약 전문가입니다.
요약을 읽는 사람은 이 문서를 접수한 담당 공무원입니다.
"이 문서로 내가 무엇을, 언제까지, 어떻게 해야 하는가"가 즉시 파악되도록 아래 JSON 스키마로만 답하세요.

{
  "doc_type": "문서 종류 — 2~8자 명사형 (예: 자료제출요구, 협조요청, 사기주의, 계획알림, 회의개최). 서술형 금지",
  "title": "공문 원문의 제목(제목 필드 그대로). 없으면 null",
  "doc_no": "시행 문서번호 (예: 기획예산과-11115). 없으면 null",
  "sender": "발신 기관·부서 (예: 장성군청 관광과). 없으면 null",
  "receiver": "수신처 (예: 각 자치구, 수신자 참조). 없으면 null",
  "sent_date": "시행일을 YYYY-MM-DD로. 없으면 null",
  "action_required": "JSON boolean(true/false)로만. 수신 부서가 실제로 해야 할 조치가 있으면 true, 단순 참고·공유·안내면 false",
  "one_line": "핵심을 25자 내외 개조식으로. '~요청'·'~안내'·'~통보'처럼 명사형 종결 ('~하는 공문입니다' 같은 서술 금지)",
  "deadline": "수신자가 제출·회신·신청 등 조치를 완료해야 하는 마감일을 YYYY-MM-DD로. 행사일·회의 개최일 자체는 기한이 아님(참석 신청 마감이 따로 있으면 그 날짜). 기한이 없으면 null",
  "key_points": ["'라벨: 내용' 형태. 라벨은 2~6자 명사(예: 발생일, 수법, 대상, 범위, 근거)이며 라벨 안에 콜론·괄호를 넣지 말 것. 항목 간 라벨 중복 금지. 내용은 개조식으로 짧게 ('~합니다' 서술 금지)"],
  "actions": ["수신자가 해야 할 조치를 개조식 한 줄(40자 내외)로. 무엇을 + 어디로 + 언제까지는 담되 '~게재', '~제출'처럼 간결하게 끝맺고 '주시기 바랍니다'류 존댓말 서술 금지. 없으면 빈 배열"],
  "cautions": ["본문에 명시된 주의·특이사항만 개조식으로 짧게: ※ 표시 문구, '필수'·'반드시' 요구, 미이행 시 불이익, 타 부서 확인 요청 등. 없으면 빈 배열"]
}

요약 원칙:
- 요약은 원문 문장 복사가 아니라 정보의 재구성입니다. 원문 표현을 그대로 옮기지 말고 압축하세요.
- one_line에 담은 내용을 key_points에 반복하지 마세요. key_points 항목 간에도 중복 금지.
- 본문이 짧으면 key_points는 2~3개로 충분합니다. 억지로 채우지 마세요.
- 전화번호·계좌번호·문서번호 등 식별 정보는 조작 없이 정확히 유지하세요.
- 문서에 날짜가 여러 개면 의미를 구분하세요: 발생일·시행일은 key_points의 라벨로,
  수신자의 조치 마감일만 deadline으로. 같은 날짜를 두 곳에 중복 배치하지 마세요.
- title·doc_no·sender·receiver·sent_date는 원문에 표기된 것만 그대로 옮기고, 없으면 null.
  key_points에 같은 서지정보(문서번호·발신처)를 또 넣지 마세요.
- 모든 항목은 개조식이되 자연스러운 한국어로. 조사를 어색하게 생략한 기계적 나열, 번역투,
  '~임'의 남발을 피하고, 사람이 소리 내어 읽었을 때 매끄럽게 쓰세요.
- key_points·actions·cautions에서 중요한 기한·날짜·핵심 행동·금액은 **이렇게** 마크다운 볼드로
  감싸 강조하세요. 항목당 1~2곳만, 남발 금지.

입력은 [문서관리카드 정보](시스템 메타데이터)와 [공문 본문] 섹션으로 나뉘어 올 수 있습니다.
[공문 본문]이 있으면 요약의 중심으로 삼고, 카드 정보는 공개여부·첨부파일 등 보조 정보로만 쓰세요.

규칙:
- 날짜·기한·금액·문서번호·부서명은 원문 그대로 정확히 옮기세요. 기한은 요일 표기까지 유지하세요 (예: "2026. 8. 4.(화)까지").
- ※ 표시 문구와 붙임 문서의 지시사항도 놓치지 말고 actions/cautions에 반영하세요.
- 본문에 없는 내용을 지어내지 마세요. 특히 cautions에 본문에 없는 일반적인 보안·행정 상식을 창작해 넣지 마세요.
- cautions는 [공문 본문]에서 뽑으세요. [문서관리카드 정보]에 있는 공개 설정·DRM·개인정보 안내 등 시스템 안내 문구는 이 문서 고유의 주의사항이 아니므로 제외하세요.
- 시스템 메뉴/버튼 텍스트 등 문서와 무관한 잡음은 무시하세요.`;

const REVIEW_PROMPT = `당신은 한국 공공기관 결재 문서의 사전 검토 보조자입니다.
결재자(또는 상신 전 기안자)가 빠르게 판단할 수 있도록, 제공된 원문만 근거로 아래 JSON 스키마로만 답하세요.

{
  "status": "결재 가능 | 일부 보완 후 결재 권장 | 주요사항 확인 필요 | 재검토 권장 중 하나",
  "summary": "문서 목적 + 검토 결론을 개조식 1~2문장으로. '~필요'·'~권장'·'~없음'처럼 명사형 종결",
  "strengths": [{"title": "2~8자 명사(예: 추진근거, 대상범위)", "content": "원문에서 확인되는 잘된 점을 개조식 40자 내외로"}],
  "improvements": [{"title": "2~8자 명사(예: 산출근거, 일정)", "content": "무엇이 빠졌고 무엇을 채워야 하는지 개조식 40자 내외로"}],
  "checks": [{"title": "2~8자 명사(예: 예산협의)", "content": "결재 전 확인할 사실관계를 개조식 40자 내외로"}]
}

판정 기준:
- "결재 가능": 핵심 내용이 충분하고 판단을 방해할 누락·확인사항이 없음
- "일부 보완 후 결재 권장": 목적·내용은 명확하나 일부 설명·근거·실행사항의 보완이 필요
- "주요사항 확인 필요": 금액·일정·첨부·역할·계약조건 등 결재 전 확인할 중요한 사실관계 존재
- "재검토 권장": 목적·추진 근거·핵심 계획이 불명확하거나 내용 간 중요한 모순 존재

문체 원칙 (중요):
- 모든 항목은 개조식. '~합니다'·'~했습니다'·'~되면 좋습니다'·'~필요가 있습니다' 같은
  서술형 종결 금지. '~명시'·'~보완 필요'·'~확인 필요'처럼 명사형으로 끝맺으세요.
- title은 판단 없이 대상만 담은 2~8자 명사. '~필요'·'~강화'·'명확한' 같은 수식·판단은
  content로 보내세요. (나쁜 예: "명확한 문서 근거 제시" → 좋은 예: "문서근거")
- content는 title의 단어를 반복하지 말고 근거와 방향만 짧게. '좀 더'·'독려'·'확보했습니다'·
  '중요합니다' 같은 미사여구·번역투·상투어 금지.
- 중요한 기한·금액·대상·행동은 **이렇게** 마크다운 볼드로 항목당 1곳 이내 강조.
- 개조식이되 조사를 어색하게 생략한 기계적 나열은 피하고, 소리 내어 읽어 매끄러운 한국어로.

검토 원칙:
- 제공되지 않은 사실·법령·금액·일정·기관 방침을 추정하거나 만들어내지 마세요.
- 문서의 목적과 유형에 필요한 항목만 검토하세요. 모든 문서에 예산·법령·KPI·보안대책·비교견적이
  반드시 필요하다고 판단하지 마세요. 단순 안내·공유 공문에 실행 방안·성과지표를 요구하지 마세요.
- 원문만으로 판단 가능한 누락·모호함은 improvements에, 실제 사실관계·금액 정확성·협의 여부처럼
  외부 확인이 필요한 사항은 checks에 쓰세요.
- 본문에 기재된 금액·수량·기간이 서로 일치하는지 확인하세요.
- strengths는 원문에서 명확하게 확인되는 내용만 쓰세요. 근거 없는 칭찬이나 일반적인 평가 금지.
- 맞춤법·띄어쓰기·사소한 문체는 결재 판단에 영향을 주는 경우에만 언급하세요.
- 같은 내용을 여러 항목에서 반복하지 말고, 문제를 과장하지 말고 결재 판단에 중요한 사항을 우선하세요.
- strengths 최대 2개, improvements 최대 3개, checks 최대 2개. 해당 내용이 없으면 억지로 채우지
  말고 빈 배열 []을 쓰세요.
- JSON 밖에 설명·인사말·마크다운을 출력하지 마세요.`;

// ── 공통: 타임아웃·에러 매핑 (KYCI 실전 패턴 이식) ──
const IDLE_MS = 30000;   // 스트리밍 청크 간 최대 대기
const HARD_MS = 120000;  // 요청 전체 최대 시간

function apiError(status, body = '') {
  const detail = String(body).slice(0, 300);
  if (status === 401 || status === 403 || (status === 400 && /api.?key/i.test(detail))) {
    return new Error('API 키가 올바르지 않습니다 — ⚙ 설정에서 확인하세요.');
  }
  if (status === 429) return new Error('요청이 많아 잠시 제한되었습니다(429). 잠시 후 다시 시도하세요.');
  if (status === 408 || status >= 500) return new Error(`AI 서비스가 원활하지 않습니다(${status}). 잠시 후 다시 시도하세요.`);
  return new Error(`LLM API ${status}: ${detail}`);
}

// fetch 자체 실패(서버 미기동, 내부망 밖 등)를 사용자 언어로
function fetchError(e) {
  if (e instanceof TypeError) return new Error('LLM 서버에 연결할 수 없습니다 — 주소와 네트워크(내부망/VPN)를 확인하세요.');
  return e;
}

export async function summarize(text, config, opts = {}) {
  return requestLlm(text, config, 'summary', opts);
}

export async function review(text, config, opts = {}) {
  return requestLlm(text, config, 'review', opts);
}

async function requestLlm(text, config, mode, { onPartial } = {}) {
  const sys = mode === 'review' ? REVIEW_PROMPT : SYSTEM_PROMPT;
  const onAccum = onPartial ? (acc) => { try { onPartial(parsePartial(acc, mode)); } catch { /* 렌더 실패는 무시 */ } } : null;
  const provider = config.provider || 'gemini';
  let raw;
  try {
    raw = provider === 'gemini'
      ? await callGemini(text, config, sys, onAccum)
      : await callOpenAI(text, config, sys, onAccum);
  } catch (e) {
    throw fetchError(e);
  }
  return mode === 'review' ? parseReview(raw) : parseResult(raw);
}

async function callGemini(text, config, sys, onAccum) {
  const model = config.model || 'gemini-flash-latest';
  const method = onAccum ? 'streamGenerateContent?alt=sse' : 'generateContent';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${method}`;
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
  });
  if (!res.ok) throw apiError(res.status, await res.text());

  if (!onAccum) {
    const data = await res.json();
    const raw = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('');
    if (!raw) throw new Error('Gemini 응답에 텍스트가 없습니다: ' + JSON.stringify(data).slice(0, 300));
    return raw;
  }

  let acc = '';
  await readSse(res, (data) => {
    const t = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    if (t) { acc += t; onAccum(acc); }
  });
  if (!acc) throw new Error('Gemini 스트리밍 응답이 비어 있습니다.');
  return acc;
}

async function callOpenAI(text, config, sys, onAccum) {
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
    });
  let res = await call(payload);
  if (res.status === 400) {
    // 일부 서버는 response_format·reasoning_effort·chat_template_kwargs 미지원 — 빼고 재시도 (프롬프트가 JSON을 강제함)
    const { response_format, reasoning_effort, chat_template_kwargs, ...rest } = payload;
    res = await call(rest);
  }
  if (!res.ok) throw apiError(res.status, await res.text());

  if (!onAccum) {
    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) throw new Error('LLM 응답에 텍스트가 없습니다.');
    return raw;
  }

  // 스트리밍 요청인데 SSE가 아닌 응답: 스트리밍 미지원 서버의 일반 JSON이거나 오류 본문 (KYCI 실측 케이스)
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  if (!ctype.includes('text/event-stream')) {
    const data = await res.json().catch(() => null);
    const raw = data?.choices?.[0]?.message?.content;
    if (raw) { onAccum(raw); return raw; }
    throw new Error(data?.error?.message || '스트리밍 응답 형식을 지원하지 않는 서버입니다.');
  }

  let acc = '';
  await readSse(res, (data) => {
    if (data.error) throw apiError(Number(data.error.code) || 0, data.error.message || JSON.stringify(data.error));
    const t = data.choices?.[0]?.delta?.content ?? '';
    if (t) { acc += t; onAccum(acc); }
  });
  if (!acc) throw new Error('LLM 스트리밍 응답이 비어 있습니다.');
  return acc;
}

// SSE(text/event-stream) 본문을 읽어 data: JSON마다 onData 호출.
// 청크 간 IDLE_MS, 전체 HARD_MS 이중 타임아웃 — 멈춘 스트림을 끝없이 기다리지 않는다.
async function readSse(res, onData) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const deadline = Date.now() + HARD_MS;
  let buf = '';
  try {
    while (true) {
      if (Date.now() > deadline) throw new Error('AI 응답이 제한 시간(2분)을 넘겼습니다.');
      let timer;
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise((_, rej) => {
          timer = setTimeout(
            () => rej(new Error('AI 응답 스트림이 30초간 멈췄습니다. 잠시 후 다시 시도하세요.')),
            Math.min(IDLE_MS, Math.max(1, deadline - Date.now()))
          );
        }),
      ]).finally(() => clearTimeout(timer));
      buf += dec.decode(value || new Uint8Array(), { stream: !done });
      const blocks = buf.split(/\r?\n\r?\n/);
      buf = blocks.pop() ?? '';
      for (const block of blocks) {
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n');
        if (!data) continue;
        if (data === '[DONE]') return;
        let json;
        try { json = JSON.parse(data); } catch { continue; }
        onData(json);
      }
      if (done) return;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

// ── 응답 파싱 ──

const stripFences = (raw) => String(raw ?? '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

function parseResult(raw) {
  const stripped = stripFences(raw);
  try {
    const r = JSON.parse(stripped);
    // 모델이 boolean 대신 문자열 "true"/"false"를 줄 때 대비 ("false"는 truthy)
    r.action_required = r.action_required === true || r.action_required === 'true';
    return r;
  } catch {
    // JSON 파싱 실패 시 원문을 one_line으로라도 보여줌
    return { doc_type: '?', one_line: stripped.slice(0, 500), key_points: [], actions: [], cautions: [] };
  }
}

function parseReview(raw) {
  const stripped = stripFences(raw);
  const start = stripped.indexOf('{');
  try {
    const r = JSON.parse(start >= 0 ? stripped.slice(start) : stripped);
    const arr = (v) => (Array.isArray(v) ? v : [])
      .filter((x) => x && (x.content || x.title))
      .map((x) => ({ title: String(x.title || '').trim(), content: String(x.content || '').trim() }));
    return {
      status: String(r.status || '').trim() || '검토 결과',
      summary: String(r.summary || '').trim(),
      strengths: arr(r.strengths),
      improvements: arr(r.improvements),
      checks: arr(r.checks),
    };
  } catch {
    return { status: '검토 결과', summary: stripped.slice(0, 500), strengths: [], improvements: [], checks: [] };
  }
}

// ── 스트리밍 부분 파싱: 미완성 JSON에서 값 추출 (KYCI 파서 이식·일반화) ──

const UNESC = { n: '\n', r: '', t: ' ', '"': '"', '\\': '\\' };

// s[from]부터 JSON 문자열 내용을 읽음 (닫는 따옴표가 아직 없어도 지금까지의 값 반환)
function readJsonString(s, from) {
  let out = '';
  let esc = false;
  let i = from;
  for (; i < s.length; i++) {
    const c = s[i];
    if (esc) { out += UNESC[c] ?? c; esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
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

function pArr(s, key, max = 12) {
  const m = new RegExp(`"${key}"\\s*:\\s*\\[`).exec(s);
  if (!m) return [];
  const out = [];
  let i = m.index + m[0].length;
  while (i < s.length && out.length < max) {
    const c = s[i];
    if (c === '"') {
      const r = readJsonString(s, i + 1);
      if (r.value.trim()) out.push(r.value.trim());
      i = r.end + 1;
      continue;
    }
    if (c === ']') break;
    i++;
  }
  return out;
}

// {"title":"...","content":"..."} 객체 배열 — 완성된 객체만 수집 (스트리밍 중 잘린 꼬리는 다음 틱에서)
function pObjArr(s, key) {
  const m = new RegExp(`"${key}"\\s*:\\s*\\[`).exec(s);
  if (!m) return [];
  const tail = s.slice(m.index + m[0].length);
  const cut = tail.indexOf(']');
  const seg = cut >= 0 ? tail.slice(0, cut) : tail;
  const out = [];
  const re = /\{\s*"title"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"content"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
  let mm;
  while ((mm = re.exec(seg))) {
    const un = (v) => v.replace(/\\(.)/g, (_, c) => UNESC[c] ?? c).trim();
    out.push({ title: un(mm[1]), content: un(mm[2]) });
  }
  return out;
}

function parsePartial(acc, mode) {
  const s = stripFences(acc);
  if (mode === 'review') {
    return {
      __partial: true,
      status: pStr(s, 'status'),
      summary: pStr(s, 'summary'),
      strengths: pObjArr(s, 'strengths'),
      improvements: pObjArr(s, 'improvements'),
      checks: pObjArr(s, 'checks'),
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

// ── 옵션 페이지 연결 테스트: 모델 목록 + 초소형 실호출로 왕복 확인 ──
export async function testConnection(config) {
  try {
    if ((config.provider || 'gemini') === 'gemini') {
      const model = config.model || 'gemini-flash-latest';
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: '응답은 OK 한 단어로만 하세요.' }] }] }),
      });
      if (!res.ok) throw apiError(res.status, await res.text());
      const t = ((await res.json()).candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
      return `연결 성공 (${model}${t ? ` → "${t.slice(0, 30)}"` : ''})`;
    }
    const base = (config.baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
    const auth = config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
    const mres = await fetch(`${base}/v1/models`, { headers: auth });
    if (!mres.ok) throw apiError(mres.status, await mres.text());
    const models = (((await mres.json()).data) || []).map((m) => m.id);
    const model = config.model || models[0];
    if (!model) throw new Error('서버에 설치된 모델이 없습니다.');
    const cres = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: '응답은 OK 한 단어로만 하세요.' }] }),
    });
    if (!cres.ok) throw apiError(cres.status, await cres.text());
    const t = ((await cres.json()).choices?.[0]?.message?.content || '').trim();
    return `연결 성공 — 설치 모델 ${models.length}개, ${model}${t ? ` → "${t.slice(0, 30)}"` : ''}`;
  } catch (e) {
    throw fetchError(e);
  }
}
