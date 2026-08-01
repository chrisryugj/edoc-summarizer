// 프레임별 추출 결과 중 LLM에 보낼 소스 선정. popup.js와 background.js 공용.
export const MAX_CHARS = 30000; // LLM에 보낼 본문 상한
export const MIN_CHARS = 50;    // 이 미만이면 추출 실패로 간주

// 최상위 문서와 같은 출처인 프레임만 남긴다.
// 확장은 <all_urls> 성격의 접근으로 크로스오리진 iframe에도 주입되므로, 거르지 않으면
// 공격자 페이지가 임베드한 타 사이트의 인증된 문서까지 수집해 LLM으로 보내고
// 그 결과를 공격자 페이지 DOM에 렌더하게 된다(동일 출처 정책 우회).
export function sameOriginFrames(frames, topOrigin) {
  if (!topOrigin) return { frames, dropped: 0, droppedOrigins: [] };
  const kept = [];
  const droppedOrigins = new Set();
  for (const f of frames) {
    if (f.origin && f.origin === topOrigin) kept.push(f);
    // 뷰어가 다른 서브도메인에 있어 본문이 통째로 걸러지는 경우를 사용자가 알 수 있게
    // 어떤 출처가 빠졌는지 남긴다 (텍스트는 남기지 않는다).
    else if (f.bodyText?.length >= MIN_CHARS) droppedOrigins.add(f.origin || '(알 수 없음)');
  }
  return { frames: kept, dropped: frames.length - kept.length, droppedOrigins: [...droppedOrigins] };
}

// LLM 입력 상한 적용 — 잘렸는지 여부를 함께 돌려줘 사용자에게 고지할 수 있게 한다.
export function clampText(text) {
  const s = String(text || '');
  return { text: s.slice(0, MAX_CHARS), truncated: s.length > MAX_CHARS, original: s.length };
}

// frames: extractor.js가 프레임마다 반환한 객체 배열
// 우선순위: 드래그 선택 > (사이트 룰 매칭 + HWP 뷰어 본문 병합) > 최장 본문 프레임
export function pickSource(frames) {
  const sel = frames.find((f) => f.selection?.length >= MIN_CHARS);
  if (sel) return { text: sel.selection, title: sel.title, how: '선택 영역' };

  // 전자문서: 문서관리카드 메타(룰 매칭) + HWP 뷰어 프레임의 공문 본문을 합쳐서 보냄
  const ruled = frames.find((f) => f.ruleText?.length >= MIN_CHARS);
  const byLen = (a, b) => b.bodyText.length - a.bodyText.length;
  // 뷰어 UI 프레임(hwpctrl*.html, 메뉴·툴바 텍스트)보다 내부 콘텐츠 프레임(본문)을 우선
  let hwp = frames
    .filter((f) => f.isHwpViewer && f.bodyText?.length >= MIN_CHARS)
    .sort((a, b) => (/hwpctrl/i.test(a.url) - /hwpctrl/i.test(b.url)) || byLen(a, b))[0];
  let guessed = false;
  if (ruled && !hwp) {
    // 뷰어 프레임 판정이 실패해도, 카드 페이지의 하위 프레임 중 실질 텍스트를 가진 건
    // 사실상 본문뿐 — 최장 텍스트 프레임을 본문 후보로 추정
    hwp = frames.filter((f) => !f.isTop && f !== ruled && f.bodyText?.length >= MIN_CHARS).sort(byLen)[0];
    guessed = !!hwp;
  }
  if (ruled || hwp) {
    const parts = [];
    if (ruled) parts.push('[문서관리카드 정보]\n' + ruled.ruleText);
    if (hwp) parts.push('[공문 본문]\n' + hwp.bodyText);
    const how = ruled && hwp ? (guessed ? '카드+본문(추정)' : '카드+본문') : ruled ? '문서카드' : 'HWP 뷰어';
    return { text: parts.join('\n\n'), title: ruled?.title || hwp?.title, how };
  }

  const best = frames
    .filter((f) => f.bodyText?.length >= MIN_CHARS)
    .sort((a, b) => b.bodyText.length - a.bodyText.length)[0];
  if (best) return { text: best.bodyText, title: best.title, how: '페이지 전체' };
  return null;
}
