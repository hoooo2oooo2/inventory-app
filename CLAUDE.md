# ai-shopping (재고관리 시스템)

## ⚠️ 운영 데이터 안전 규칙 — 최우선, 반드시 먼저 읽을 것

이 프로젝트는 **실사용 중인 운영 앱**이다. 로컬 프리뷰(정적 서버 등)에서도 `sb`(Supabase 클라이언트)는
**실제 운영 DB에 직접 연결**된다 — "테스트"라고 해서 안전한 별도 환경이 아니다.

**절대 규칙: 실제 저장된 데이터(Supabase의 모든 테이블 — products, daily_sales, work_calendar,
receive_list 등)를 추가/수정/삭제하는 것은, 사용자가 "지금 이 대화에서" 명시적으로 그 작업을
요청했을 때만 실행한다.**

- 과거에 비슷한 걸 허락받았다고, 혹은 "이렇게 하는 게 맞을 것 같다"는 판단만으로 실데이터를
  건드리지 않는다. 애매하면 실행하지 말고 먼저 물어본다.
- **코드 수정과 실데이터 변경은 완전히 별개의 승인 대상이다.** 버그를 발견해도 코드만 고치고,
  DB에 이미 들어간 값을 고치거나 지우는 건 별도로 명시적 허락을 받는다.
- **읽기(SELECT)는 자유롭게 허용.** 버그 원인 조사 등에 실제 데이터를 읽어서 확인하는 것은 괜찮다.
  Supabase anon key는 `index.html` 상단(`SUPABASE_URL`/`SUPABASE_KEY`)에 있고, REST API로 직접
  조회 가능하다 (`GET .../rest/v1/<table>?select=...`).
- **검증/테스트 시 쓰기 계열 함수를 실제로 호출하지 않는다.** `cloudKvSave`, `sb.from(...).update/insert/
  delete/upsert`, `_reportAutoSave`/`_reportFlushSave`, `reportMovePin`/`reportPinLine`/`reportEditPin`
  같이 저장을 유발하는 함수를 프리뷰에서 검증할 때는 **반드시 mock 처리**해서 실제 네트워크 쓰기가
  나가지 않게 한다. 로직 확인은 가짜(합성) 데이터로 하고 저장 없이 폐기한다.
- 이 규칙은 **새 세션, 다른 Claude 계정**에서 작업하더라도 동일하게 적용된다. 이 프로젝트를 열 때마다
  이 파일을 먼저 확인한다.

과거 이 규칙을 어겨서 실제로 데이터가 유실된 사고가 있었다 (2026-06-23 업무보고서 전체 유실,
2026-07-07 재고관리 자동정상화 버그로 3개 상품 판매데이터 오염 등). 반드시 위 규칙을 지킬 것.

## 배포
- 배포 = `git push origin main` → GitHub Pages 자동 빌드 (레포: `hoooo2oooo2/inventory-app`)
- 배포 확인: `https://api.github.com/repos/hoooo2oooo2/inventory-app/deployments`에서 최신 커밋
  SHA의 상태(`success`)를 확인. CDN 캐시가 10분(`Cache-Control: max-age=600`)이라 방금 배포 직후엔
  강력 새로고침(Ctrl+Shift+R) 안내가 필요할 수 있다.

## 구조
- **배포되는 앱은 루트의 `index.html`** (standalone, 단일 파일, React 등 인라인, Supabase 직접 연동).
- `src/App.jsx`는 사용되지 않는 별개 프로젝트다. 이 폴더를 고쳐도 실제 앱엔 반영되지 않는다.
- Supabase 프로젝트 ref: `ywbekolvslixidpugepr`. anon key는 index.html에 공개돼 있고 RLS로 보호되는
  전제이나, 이 앱은 쓰기(update/insert/delete)까지 anon key로 직접 수행하므로 각별히 주의한다.
