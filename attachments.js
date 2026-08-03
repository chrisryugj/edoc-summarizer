// 페이지(같은 출처 프레임)에 주입되어 문서관리카드의 첨부파일을 찾아 내용 텍스트를 추출한다.
// background.js에서 chrome.scripting.executeScript({ files: ['attachments.js'], allFrames: true })로 실행.
// 마지막 표현식(async IIFE)의 Promise가 executeScript 결과로 전달된다.
//
// 흐름: DOM에서 파일명·링크 발견 → 같은 출처만 fetch(세션 쿠키 포함) → 형식별 텍스트 추출.
//   - hwp  : CFB(Compound File) 직접 파싱 — BodyText/Section* 레코드(deflate-raw) → 실패 시 PrvText 미리보기
//   - hwpx : ZIP — Preview/PrvText.txt → 없으면 Contents/section*.xml 태그 제거
//   - docx/xlsx/pptx : ZIP 내부 XML 태그 제거
//   - txt/csv : UTF-8 → 깨지면 EUC-KR 재시도
//   - pdf 등 나머지 : 미지원 — 파일명만 보고 (BACKEND.md 원칙)
// 다운로드 링크가 JS 함수 호출(onclick)뿐이라 URL을 못 얻는 경우는 no-link로 보고하고
// 디버그 문자열에 onclick 원문을 남긴다 — 실기기에서 다음 라운드 셀렉터 튜닝용.
(async () => {
  const MAX_FILES = 5;                 // 프레임당 내용 추출 시도 상한
  const MAX_BYTES = 20 * 1024 * 1024;  // 파일당 다운로드 상한
  const PER_FILE_CHARS = 12000;        // 파일당 추출 텍스트 상한
  const EXTS = 'hwpx?|docx?|xlsx?|pptx?|pdf|txt|csv|zip';
  // 조각 매칭용 — 텍스트가 긴 요소에서 파일명 후보를 찾을 때만 쓴다
  const EXT_RE = new RegExp(`([^\\s/\\\\|<>:"?*]+\\.(${EXTS}))\\b`, 'i');
  // 요소 텍스트 전체가 파일명인 경우 — 공백이 든 이름을 통째로 잡는다
  // (예: "AI전략팀 업무분장표(2026. 7. 31.字).hwpx", "계획서.hwpx (34KB)")
  const FULL_RE = new RegExp(`^(.{1,150}\\.(${EXTS}))\\s*(?:[([][^)\\]]{0,20}[)\\]])?$`, 'i');
  const LABEL_RE = /^(첨부파일|첨부|붙임|파일)\s*[:：]?\s*/;
  // background가 kordoc 헬퍼(로컬 변환 서버)를 감지하면 주입 전에 이 플래그를 세운다.
  // 켜져 있으면 원본 바이트(base64)도 함께 돌려줘 background가 kordoc으로 고품질 변환한다
  // (내장 파서 결과는 헬퍼 실패 시 폴백). pdf처럼 내장 파서가 못 읽는 형식도 kordoc은 처리.
  const USE_KORDOC = globalThis.__edocKordoc === true;
  // 이름만 훑는 모드 — 첨부를 분석할지 사용자에게 묻기 전에 목록만 확인할 때 쓴다(다운로드 없음)
  const SCAN_ONLY = globalThis.__edocScanOnly === true;
  const B64_FILE_MAX = 6 * 1024 * 1024;   // kordoc 전달용 파일당 상한
  let b64Budget = 12 * 1024 * 1024;       // 프레임당 전달 총량 (executeScript 메시지 크기 보호)
  const toB64 = (u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };

  const out = {
    origin: (typeof self !== 'undefined' && self.origin) || location.origin || '',
    items: [],
    debug: '',
  };

  const normalize = (s) => String(s || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const clampNote = (t) => (t.length > PER_FILE_CHARS
    ? { text: t.slice(0, PER_FILE_CHARS), note: `길어서 앞 ${PER_FILE_CHARS.toLocaleString()}자만` }
    : { text: t, note: '' });

  // ── 형식 공통 유틸 ──
  const inflateRaw = async (u8) => new Uint8Array(
    await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()
  );
  const decodeEntities = (s) => s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  // 문단 닫힘만 줄바꿈으로 살리고 나머지 태그는 제거 (w:p=docx, hp:p=hwpx, a:p=pptx)
  const stripXml = (s) => decodeEntities(
    s.replace(/<\/(w:p|hp:p|a:p|si)>/g, '\n').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, '')
  );

  // ── ZIP 리더 (central directory + deflate-raw) ──
  function zipEntries(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);
    const entries = [];
    for (let n = 0; n < count; n++) {
      if (off + 46 > u8.length || dv.getUint32(off, true) !== 0x02014b50) break;
      const method = dv.getUint16(off + 10, true);
      const csize = dv.getUint32(off + 20, true);
      const nlen = dv.getUint16(off + 28, true);
      const elen = dv.getUint16(off + 30, true);
      const clen = dv.getUint16(off + 32, true);
      const lho = dv.getUint32(off + 42, true);
      const name = new TextDecoder().decode(u8.subarray(off + 46, off + 46 + nlen));
      entries.push({ name, method, csize, lho });
      off += 46 + nlen + elen + clen;
    }
    return entries;
  }
  async function zipRead(u8, entry) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (entry.lho + 30 > u8.length || dv.getUint32(entry.lho, true) !== 0x04034b50) return null;
    const nlen = dv.getUint16(entry.lho + 26, true);
    const elen = dv.getUint16(entry.lho + 28, true);
    const start = entry.lho + 30 + nlen + elen;
    const data = u8.subarray(start, start + entry.csize);
    if (entry.method === 0) return data;
    if (entry.method === 8) return inflateRaw(data);
    return null;
  }
  const zipText = async (u8, entry) => new TextDecoder().decode(await zipRead(u8, entry));

  // ── CFB(Compound File Binary) 리더 — .hwp 컨테이너 ──
  function cfbOpen(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const sectorSize = 1 << dv.getUint16(30, true);   // 보통 512
    const FREE = 0xFFFFFFFF;
    const END = 0xFFFFFFFE;
    const secOfs = (i) => (i + 1) * sectorSize;

    // FAT: 헤더 DIFAT 109개 + DIFAT 체인
    const fatSectors = [];
    for (let i = 0; i < 109; i++) {
      const s = dv.getUint32(76 + i * 4, true);
      if (s !== FREE) fatSectors.push(s);
    }
    let difat = dv.getUint32(68, true);
    const perDifat = sectorSize / 4 - 1;
    for (let guard = 0; difat !== END && difat !== FREE && guard < 10000; guard++) {
      const base = secOfs(difat);
      for (let i = 0; i < perDifat; i++) {
        const s = dv.getUint32(base + i * 4, true);
        if (s !== FREE) fatSectors.push(s);
      }
      difat = dv.getUint32(base + perDifat * 4, true);
    }
    const fat = [];
    for (const s of fatSectors) {
      const base = secOfs(s);
      for (let i = 0; i < sectorSize / 4; i++) fat.push(dv.getUint32(base + i * 4, true));
    }
    const chain = (start) => {
      const secs = [];
      for (let s = start, guard = 0; s !== END && s !== FREE && s < fat.length + 2 && guard < 1e6; s = fat[s], guard++) secs.push(s);
      return secs;
    };
    const readChain = (start, size) => {
      const secs = chain(start);
      const buf = new Uint8Array(secs.length * sectorSize);
      secs.forEach((s, i) => buf.set(u8.subarray(secOfs(s), secOfs(s) + sectorSize), i * sectorSize));
      return buf.subarray(0, size);
    };

    // 디렉터리 엔트리(128바이트) 전체 스캔
    const dirBuf = readChain(dv.getUint32(48, true), Infinity);
    const entries = [];
    for (let off = 0; off + 128 <= dirBuf.length; off += 128) {
      const edv = new DataView(dirBuf.buffer, dirBuf.byteOffset + off, 128);
      const nameLen = edv.getUint16(64, true);
      const type = edv.getUint8(66);
      if (!nameLen || (type !== 1 && type !== 2 && type !== 5)) continue;
      entries.push({
        name: new TextDecoder('utf-16le').decode(dirBuf.subarray(off, off + nameLen - 2)),
        type,
        start: edv.getUint32(116, true),
        size: edv.getUint32(120, true),
      });
    }
    const root = entries.find((e) => e.type === 5);

    // 미니FAT: 4096바이트 미만 스트림은 루트의 미니 스트림(64바이트 섹터) 안에 있다
    const miniFat = [];
    for (const s of chain(dv.getUint32(60, true))) {
      const base = secOfs(s);
      for (let i = 0; i < sectorSize / 4; i++) miniFat.push(dv.getUint32(base + i * 4, true));
    }
    const miniStream = root ? readChain(root.start, root.size) : new Uint8Array(0);
    const readMini = (start, size) => {
      const parts = [];
      for (let s = start, guard = 0; s !== END && s !== FREE && s < miniFat.length && guard < 1e6; s = miniFat[s], guard++) {
        parts.push(miniStream.subarray(s * 64, s * 64 + 64));
      }
      const buf = new Uint8Array(parts.length * 64);
      parts.forEach((p, i) => buf.set(p, i * 64));
      return buf.subarray(0, size);
    };

    return {
      stream(name) {
        const e = entries.find((x) => x.type === 2 && x.name === name);
        if (!e) return null;
        return e.size < 4096 ? readMini(e.start, e.size) : readChain(e.start, e.size);
      },
    };
  }

  // HWP 레코드 스트림에서 본문 텍스트(HWPTAG_PARA_TEXT=67) 수집
  function hwpRecordsText(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let pos = 0;
    let text = '';
    while (pos + 4 <= u8.length) {
      const h = dv.getUint32(pos, true);
      const tag = h & 0x3FF;
      let size = (h >>> 20) & 0xFFF;
      pos += 4;
      if (size === 0xFFF) { size = dv.getUint32(pos, true); pos += 4; }
      if (pos + size > u8.length) break;
      if (tag === 67) {
        // UTF-16LE + 제어문자: 13/10=문단, 9=탭, 1~23(비문자)은 8워드 블록 점유
        for (let i = 0; i + 1 < size; i += 2) {
          const c = dv.getUint16(pos + i, true);
          if (c === 13 || c === 10) text += '\n';
          else if (c === 9) text += ' ';
          else if (c >= 1 && c <= 23) i += 14; // 인라인·확장 컨트롤: 자신 포함 8 WCHAR
          else if (c >= 32) text += String.fromCharCode(c);
        }
        text += '\n';
      }
      pos += size;
    }
    return text;
  }

  async function parseHwp(u8) {
    const cfb = cfbOpen(u8);
    const header = cfb.stream('FileHeader');
    if (!header || !new TextDecoder().decode(header.subarray(0, 17)).startsWith('HWP Document File')) {
      return { status: 'parse-fail', note: 'HWP 형식 아님' };
    }
    const flags = new DataView(header.buffer, header.byteOffset + 36, 4).getUint32(0, true);
    const compressed = !!(flags & 1);
    const restricted = !!(flags & 2) || !!(flags & 4); // 암호/배포용 — 본문 스트림 해석 불가
    if (!restricted) {
      let text = '';
      // CFB 디렉터리는 평면 스캔이라 스트림 이름만으로 찾는다 — 본문 섹션은 BodyText 스토리지의 Section{n}.
      // (배포용 문서의 ViewText/Section{n}은 암호화돼 있고 restricted로 걸러진다)
      for (let i = 0; i < 256; i++) {
        let sec = cfb.stream(`Section${i}`);
        if (!sec) break;
        try {
          if (compressed) sec = await inflateRaw(sec);
          text += hwpRecordsText(sec);
        } catch { break; /* 섹션 해석 실패 → 지금까지 모은 것 + PrvText 폴백 */ }
      }
      if (normalize(text).length > 50) return { status: 'ok', text: normalize(text) };
    }
    // 폴백: PrvText 미리보기(UTF-16LE 평문, 비압축) — 앞부분만이라도
    const prv = cfb.stream('PrvText');
    if (prv?.length) {
      const t = normalize(new TextDecoder('utf-16le').decode(prv));
      if (t.length > 20) return { status: 'ok', text: t, note: restricted ? '보호 문서 — 미리보기만' : '미리보기 텍스트만' };
    }
    return { status: 'parse-fail', note: restricted ? '암호화·배포용 문서' : '본문 추출 실패' };
  }

  async function parseZipDoc(u8, ext) {
    const entries = zipEntries(u8);
    if (!entries) return { status: 'parse-fail', note: 'ZIP 해석 실패' };
    const find = (re) => entries.filter((e) => re.test(e.name));
    if (ext === 'hwpx') {
      const prv = find(/^Preview\/PrvText\.txt$/i)[0];
      const secs = find(/^Contents\/section\d+\.xml$/i).sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
      let text = '';
      for (const s of secs) text += stripXml(await zipText(u8, s)) + '\n';
      if (normalize(text).length > 50) return { status: 'ok', text: normalize(text) };
      if (prv) return { status: 'ok', text: normalize(await zipText(u8, prv)), note: '미리보기 텍스트만' };
      return { status: 'parse-fail', note: '본문 섹션 없음' };
    }
    if (ext === 'docx' || ext === 'doc') {
      const doc = find(/^word\/document\.xml$/i)[0];
      if (doc) return { status: 'ok', text: normalize(stripXml(await zipText(u8, doc))) };
    }
    if (ext === 'xlsx' || ext === 'xls') {
      const ss = find(/^xl\/sharedStrings\.xml$/i)[0];
      if (ss) {
        const t = normalize(stripXml(await zipText(u8, ss)));
        if (t.length > 10) return { status: 'ok', text: t, note: '셀 텍스트만(수치·수식 제외)' };
      }
      return { status: 'parse-fail', note: '추출할 텍스트 셀 없음' };
    }
    if (ext === 'pptx' || ext === 'ppt') {
      const slides = find(/^ppt\/slides\/slide\d+\.xml$/i).sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
      let text = '';
      for (const s of slides) text += stripXml(await zipText(u8, s)) + '\n';
      if (normalize(text).length > 10) return { status: 'ok', text: normalize(text) };
    }
    // 기타 zip: 내용물 목록만이라도
    const names = entries.map((e) => e.name).slice(0, 30).join(', ');
    return { status: 'ok', text: `(압축파일 내용물 목록) ${names}`, note: '목록만' };
  }

  function parsePlainText(u8) {
    let t = new TextDecoder('utf-8').decode(u8);
    const bad = (t.match(/�/g) || []).length;
    if (bad > t.length / 100) { // 깨짐 1% 초과 → EUC-KR 재시도
      try { t = new TextDecoder('euc-kr').decode(u8); } catch { /* 미지원 인코딩 */ }
    }
    return { status: 'ok', text: normalize(t) };
  }

  async function extractOne(name, ext, u8) {
    // 매직 넘버 우선 판별 — 확장자를 속인 응답(로그인 HTML 등) 방지
    const head = new TextDecoder('latin1').decode(u8.subarray(0, 8));
    // Fasoo DRM-ONE 래핑 실측 헤더: 9b "DRMONE  This Document is encrypted ... Fasoo DRM"
    const head200 = new TextDecoder('latin1').decode(u8.subarray(0, 200));
    if (head200.includes('DRMONE') || head200.includes('Fasoo DRM')) {
      return { status: 'unsupported', note: '보안문서(Fasoo DRM) — 해제 전에는 내용 분석 불가' };
    }
    if (head.startsWith('PK\x03\x04')) return parseZipDoc(u8, ext === 'hwp' ? 'hwpx' : ext);
    if (head.startsWith('\xD0\xCF\x11\xE0')) return parseHwp(u8);
    if (head.startsWith('%PDF')) return { status: 'unsupported', note: 'PDF 텍스트 추출 미지원' };
    // 앞이 공백·빈 줄로 시작하는 JSP/HTML 응답 대비 — 넉넉히 벗겨내고 판별
    if (/^\s*<(!doctype|html|script|meta|form)/i.test(new TextDecoder('utf-8').decode(u8.subarray(0, 2048)).trimStart())) {
      return { status: 'fetch-fail', note: '다운로드 응답이 파일이 아닌 웹페이지' };
    }
    if (ext === 'txt' || ext === 'csv') return parsePlainText(u8);
    // 매직 바이트를 남긴다 — 사내 DRM(보안문서) 래핑이면 원본 형식과 무관한 바이트가 온다
    const hex = [...u8.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    return { status: 'unsupported', note: `미지원 형식(매직 ${hex} — 보안문서/DRM 가능성)` };
  }

  try {
    // ── ① 발견: 파일명처럼 보이는 텍스트를 가진 요소 수집 ──
    const found = new Map(); // name → { name, ext, url, hint }
    for (const el of document.querySelectorAll('a, button, span, td, li, label, p')) {
      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!txt || txt.length > 300) continue;
      // 요소 텍스트가 곧 파일명이면 통째로 (공백 포함), 아니면 조각 매칭으로 후보만
      const full = FULL_RE.exec(txt.replace(LABEL_RE, ''));
      const m = full || EXT_RE.exec(txt);
      if (!m) continue;
      const name = m[1];
      const prev = found.get(name);
      // 같은 파일명이면 더 구체적인(짧은 텍스트) 요소를 채택 — 부모 컨테이너 중복 제거
      if (prev && prev.txtLen <= txt.length) continue;
      const link = (el.closest('a[href]') || el.querySelector('a[href]') || (el.matches('a[href]') ? el : null));
      let url = '';
      if (link && !/^javascript:/i.test(link.getAttribute('href') || '')) {
        try {
          const u = new URL(link.getAttribute('href'), location.href);
          if (u.origin === out.origin && (u.protocol === 'https:' || u.protocol === 'http:')) url = u.href;
        } catch { /* 무효 URL */ }
      }
      const hint = (el.closest('[onclick]')?.getAttribute('onclick') || link?.getAttribute('href') || '').slice(0, 120);
      found.set(name, { name, ext: m[2].toLowerCase(), url, hint, txtLen: txt.length });
    }

    // 같은 파일이 조각난 이름으로 중복 수집되는 것을 정리한다.
    // DOM에서 파일명이 여러 노드로 쪼개지면 "업무분장표(2026.8.3.字).hwpx"의 꼬리만 잡혀
    // "(3.字).hwpx" 같은 항목이 따로 생긴다. 구두점을 무시하고 꼬리 여부를 판정한다
    // (긴 이름이 짧은 이름을 끝에 포함하고, 짧은 쪽이 20자 이하일 때만 조각으로 본다).
    const core = (s) => s.replace(/[^\p{L}\p{N}]/gu, '');
    const all = [...found.values()].sort((a, b) => b.name.length - a.name.length);
    const cands = all.filter((c, i) =>
      !all.some((o, j) => j < i && c.name.length <= 20 && core(o.name).endsWith(core(c.name))));
    out.debug = cands.slice(0, 8)
      .map((c) => `${c.name}${c.url ? '(링크)' : c.hint ? `(onclick: ${c.hint})` : '(링크 없음)'}`)
      .join(' | ').slice(0, 600);

    if (SCAN_ONLY) {
      out.items = cands.map((c) => ({ name: c.name, ext: c.ext, status: 'scan' }));
      return out;
    }

    // ── ② 다운로드 + 추출 ──
    let fetched = 0;
    for (const c of cands) {
      if (!c.url) { out.items.push({ name: c.name, status: 'no-link', diag: { hint: c.hint } }); continue; }
      if (fetched >= MAX_FILES) { out.items.push({ name: c.name, status: 'skipped', note: `상한 ${MAX_FILES}건 초과` }); continue; }
      fetched++;
      try {
        // 타임아웃 필수 — 응답 없는 다운로드 엔드포인트에 걸리면 배경 흐름 전체가
        // "첨부파일 분석 중…"에서 멈춘다 (executeScript가 이 IIFE의 Promise를 기다림)
        const res = await fetch(c.url, { credentials: 'include', signal: AbortSignal.timeout(15000) });
        if (!res.ok) { out.items.push({ name: c.name, status: 'fetch-fail', note: `HTTP ${res.status}`, diag: { url: c.url.slice(0, 300), hint: c.hint } }); continue; }
        const len = +res.headers.get('content-length') || 0;
        if (len > MAX_BYTES) { out.items.push({ name: c.name, status: 'too-big', note: `${Math.round(len / 1048576)}MB` }); continue; }
        const u8 = new Uint8Array(await res.arrayBuffer());
        if (u8.length > MAX_BYTES) { out.items.push({ name: c.name, status: 'too-big', note: `${Math.round(u8.length / 1048576)}MB` }); continue; }
        const r = await extractOne(c.name, c.ext, u8);
        // 진단용 — 무엇을 때려서 뭐가 왔는지 (SW 콘솔에서 확인, LLM에는 안 감)
        const diag = {
          url: c.url.slice(0, 300),
          hint: c.hint,
          ctype: (res.headers.get('content-type') || '').slice(0, 80),
          bytes: u8.length,
          preview: r.status === 'ok' ? '' : new TextDecoder('utf-8').decode(u8.subarray(0, 400)),
        };
        // 응답이 파일이 아니었으면(fetch-fail) kordoc에 보내도 소용없다
        let b64 = '';
        if (USE_KORDOC && r.status !== 'fetch-fail' && u8.length <= B64_FILE_MAX && b64Budget >= u8.length) {
          b64 = toB64(u8);
          b64Budget -= u8.length;
        }
        if (r.status === 'ok') {
          const { text, note } = clampNote(r.text);
          out.items.push({ name: c.name, status: 'ok', text, note: [r.note, note].filter(Boolean).join(', '), b64, diag });
        } else {
          out.items.push({ name: c.name, status: r.status, note: r.note, b64, diag });
        }
      } catch (e) {
        out.items.push({ name: c.name, status: 'fetch-fail', note: String(e.message || e).slice(0, 100), diag: { url: c.url.slice(0, 300), hint: c.hint } });
      }
    }
  } catch (e) {
    out.debug = 'ERR:' + String(e.message || e).slice(0, 200);
  }
  return out;
})();
