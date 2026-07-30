# 전자문서 AI 요약 (Edge 확장) — POC

전자문서 열람 화면에서 본문을 추출해 LLM으로 요약. 문서 종류·조치 필요 여부·한줄요약·기한(D-day)·핵심 내용·조치사항·주의점을 위젯 패널로 보여준다.

- UI는 [KRDS(대한민국 정부 디자인시스템)](https://github.com/gracefullight/krds) 컬러 토큰 기반 (Primary `#246BEB`, Secondary `#003675`, Point `#E71825`)
- 요약 패널: 복사(마크다운) · .md 저장 · 글자 크기 조절 · 다시 요약 · 헤더 드래그로 이동
- 플로팅 ✨ 버튼: 클릭 = 요약, 드래그 = 위치 이동(저장됨)
- 첨부파일 내용 분석·내부 LLM 전환 계획은 [BACKEND.md](BACKEND.md) 참고

## 설치 (Edge)

1. `edge://extensions` → 좌측 **개발자 모드** 켜기
2. **압축을 풀어서 로드** → 이 폴더(`edoc-summarizer`) 선택
3. 툴바 퍼즐 아이콘 → "전자문서 AI 요약" 고정
4. 확장 아이콘 우클릭 → **확장 옵션** → Gemini API 키 입력 ([aistudio.google.com/apikey](https://aistudio.google.com/apikey))

## 사용

- **우클릭 → "📄 이 문서 AI 요약"** (기본) — 전자문서는 툴바 없는 팝업창으로 열리므로 컨텍스트 메뉴가 주 트리거. 결과는 화면 우상단 오버레이 패널로 표시.
- 일반 탭에서는 확장 아이콘 클릭(팝업 UI)도 동작.

본문 추출 우선순위:
1. **드래그 선택한 텍스트** (추출이 이상하면 본문만 드래그하고 다시 클릭)
2. 사이트별 셀렉터(`SITE_RULES`) + HWP 뷰어 프레임 본문 **병합**
3. 모든 프레임 중 텍스트가 가장 긴 프레임
4. 전부 실패 시 붙여넣기 입력창

## 서울시 전자문서(cseoul.go.kr) 실측 반영

문서관리카드(`BmsDctEnfReceiptCardDetail.do`) DOM 덤프 기반:

- 카드 메타정보: `#DIV_ENF_DOC` (단, `#tdTask`는 레거시 JS 코드가 텍스트로 렌더링되는 노이즈라 제외)
- 공문 실제 본문: DOM이 아니라 **HWP 변환 뷰어**(`hwpctrl_frame` → hconvg1 변환서버) 프레임에 렌더링
- 추출 시 `[문서관리카드 정보]` + `[공문 본문]`을 합쳐 LLM에 전달

⚠ HWP 뷰어가 텍스트가 아닌 이미지/캔버스로 렌더링하면 본문 추출 불가 →
뷰어 프레임에서 `dump-dom.js` 재실행(F12 콘솔 컨텍스트를 `hwpctrl_frame`으로 전환)해 구조 확인 필요.

다른 시스템 추가 시: 열람 화면 F12 콘솔에서 `dump-dom.js` 실행 → 덤프 JSON을 기반으로 `extractor.js`의 `SITE_RULES`에 셀렉터 추가.

## 내부 LLM 전환

옵션에서 프로바이더를 **내부 LLM (OpenAI 호환)** 으로 바꾸고 Base URL만 입력하면 됨.
vLLM·Ollama 등 `/v1/chat/completions` 호환 서버 가정 (`llm.js:summarizeOpenAI`).

### 로컬 Ollama 실측 (2026-07-30, RX 9060 8GB)

- 설정: Base URL `http://localhost:11434`, API 키 불필요, 모델 비우면 `gemma4:e4b`
- **필수**: 확장 오리진 허용 — `OLLAMA_ORIGINS=chrome-extension://*` (User 환경변수, Ollama 재시작 필요)
- 같은 공문 요약 기준: `gemma4:e2b` 웜 18.5초 (라벨·볼드 형식 일부 미준수),
  `gemma4:e4b` 웜 30.4초 (형식 완전 준수, 품질 우수). 첫 호출은 모델 로드로 +15초쯤
- VRAM 8GB라 e4b(9.6GB)는 부분 CPU 오프로드 — 속도가 아쉬우면 e2b 사용

## 파일 구조

| 파일 | 역할 |
|---|---|
| `manifest.json` | MV3 매니페스트 |
| `background.js` | 요약 오케스트레이션: 컨텍스트 메뉴/위젯 트리거, 웹한글 API 프로브, 오버레이 렌더링 |
| `widget.js` | cseoul 문서카드 화면 플로팅 ✨ 버튼 (콘텐츠 스크립트) |
| `popup.html/js` | 툴바 아이콘용 요약 UI |
| `pick.js` | 프레임별 추출 결과 선정 (popup/background 공용) |
| `extractor.js` | 페이지 주입 추출기 (사이트 룰 + 범용 폴백) |
| `llm.js` | Gemini / OpenAI 호환 프로바이더 추상화, 요약 프롬프트 |
| `options.html/js` | API 키·모델·프로바이더 설정 |
| `dump-dom.js` | 전자문서 DOM 구조 덤프용 콘솔 스니펫 |
| `BACKEND.md` | 2단계(내부 LLM + 첨부 분석) 백엔드 아키텍처 |

## 보안 메모 (POC 한계)

- API 키는 `chrome.storage.sync`에 평문 저장 — POC용. 내부 배포 시 내부 LLM + 키 불요 구성으로 전환.
- 문서 본문이 Google 서버로 전송됨 — **비공개·민감 문서에는 사용 금지**. 내부 LLM 전환 전까지는 공개 가능한 문서로만 테스트할 것.
