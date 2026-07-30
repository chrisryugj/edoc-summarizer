// LLM 프로바이더 추상화.
// POC: Gemini API. 내부 LLM 전환 시 옵션에서 provider를 'openai'로 바꾸고
// baseUrl(내부 엔드포인트)만 지정하면 됨 — OpenAI 호환 API(vLLM, Ollama 등) 가정.

const SYSTEM_PROMPT = `당신은 한국 공공기관 전자문서 요약 전문가입니다.
요약을 읽는 사람은 이 문서를 접수한 담당 공무원입니다.
"이 문서로 내가 무엇을, 언제까지, 어떻게 해야 하는가"가 즉시 파악되도록 아래 JSON 스키마로만 답하세요.

{
  "doc_type": "문서 종류 — 2~8자 명사형 (예: 자료제출요구, 협조요청, 사기주의, 계획알림, 회의개최). 서술형 금지",
  "action_required": "JSON boolean(true/false)로만. 수신 부서가 실제로 해야 할 조치가 있으면 true, 단순 참고·공유·안내면 false",
  "one_line": "문서의 핵심을 담은 한 문장 (40자 내외)",
  "deadline": "수신자가 제출·회신·신청 등 조치를 완료해야 하는 마감일을 YYYY-MM-DD로. 행사일·회의 개최일 자체는 기한이 아님(참석 신청 마감이 따로 있으면 그 날짜). 기한이 없으면 null",
  "key_points": ["'라벨: 내용' 형태. 라벨은 2~6자 명사(예: 발생일, 수법, 대상, 범위, 근거)이며 라벨 안에 콜론·괄호를 넣지 말 것. 항목 간 라벨 중복 금지. 내용은 핵심만 간결하게"],
  "actions": ["수신자가 해야 할 조치. 각 항목은 '무엇을(서식·자료명) + 어떻게/어디로(제출처·제출방법) + 언제까지(기한, 요일 포함)'가 담긴 완결된 문장으로. 없으면 빈 배열"],
  "cautions": ["본문에 명시된 주의·특이사항만: ※ 표시 문구, '필수'·'반드시' 요구, 미이행 시 불이익, 타 부서 확인 요청 등. 없으면 빈 배열"]
}

요약 원칙:
- 요약은 원문 문장 복사가 아니라 정보의 재구성입니다. 원문 표현을 그대로 옮기지 말고 압축하세요.
- one_line에 담은 내용을 key_points에 반복하지 마세요. key_points 항목 간에도 중복 금지.
- 본문이 짧으면 key_points는 2~3개로 충분합니다. 억지로 채우지 마세요.
- 전화번호·계좌번호·문서번호 등 식별 정보는 조작 없이 정확히 유지하세요.
- 문서에 날짜가 여러 개면 의미를 구분하세요: 발생일·시행일은 key_points의 라벨로,
  수신자의 조치 마감일만 deadline으로. 같은 날짜를 두 곳에 중복 배치하지 마세요.
- 모든 문장은 자연스러운 한국어로 다듬어 쓰세요. 조사를 어색하게 생략한 기계적 나열, 번역투,
  '~임'의 남발을 피하고, 개조식이라도 사람이 소리 내어 읽었을 때 매끄럽게 쓰세요.
- one_line은 '~하는 문서', '~을 요청하는 공문'처럼 문서의 정체가 바로 잡히는 자연스러운 서술로 끝맺으세요.

입력은 [문서관리카드 정보](시스템 메타데이터)와 [공문 본문] 섹션으로 나뉘어 올 수 있습니다.
[공문 본문]이 있으면 요약의 중심으로 삼고, 카드 정보는 공개여부·첨부파일 등 보조 정보로만 쓰세요.

규칙:
- 날짜·기한·금액·문서번호·부서명은 원문 그대로 정확히 옮기세요. 기한은 요일 표기까지 유지하세요 (예: "2026. 8. 4.(화)까지").
- ※ 표시 문구와 붙임 문서의 지시사항도 놓치지 말고 actions/cautions에 반영하세요.
- 본문에 없는 내용을 지어내지 마세요. 특히 cautions에 본문에 없는 일반적인 보안·행정 상식을 창작해 넣지 마세요.
- cautions는 [공문 본문]에서 뽑으세요. [문서관리카드 정보]에 있는 공개 설정·DRM·개인정보 안내 등 시스템 안내 문구는 이 문서 고유의 주의사항이 아니므로 제외하세요.
- 시스템 메뉴/버튼 텍스트 등 문서와 무관한 잡음은 무시하세요.`;

export async function summarize(text, config) {
  const provider = config.provider || 'gemini';
  if (provider === 'gemini') return summarizeGemini(text, config);
  return summarizeOpenAI(text, config);
}

async function summarizeGemini(text, config) {
  const model = config.model || 'gemini-flash-latest';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': config.apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error('Gemini 응답에 텍스트가 없습니다: ' + JSON.stringify(data).slice(0, 300));
  return parseResult(raw);
}

async function summarizeOpenAI(text, config) {
  const base = (config.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('내부 LLM baseUrl이 설정되지 않았습니다 (옵션에서 설정).');
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.model || 'default',
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content;
  if (!raw) throw new Error('LLM 응답에 텍스트가 없습니다.');
  return parseResult(raw);
}

function parseResult(raw) {
  // 모델이 ```json 펜스를 붙이는 경우 대비
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
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
