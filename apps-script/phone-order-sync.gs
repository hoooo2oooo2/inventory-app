/**
 * 전화구매건 시트 → 재고관리 앱 동기화 (Google Apps Script)
 * ────────────────────────────────────────────────────────────
 * 대상 스프레드시트: "일일CS건" > "전화구매건" 탭
 * 저장 위치: Supabase work_calendar 테이블, person='__app__', kind='po_<행고유ID>'
 *           (앱은 kind LIKE 'po\_%' 로 목록을 조회하므로, 별도 인덱스 관리 없이
 *            이 스크립트가 건마다 개별 upsert만 하면 됩니다.)
 *
 * 설치 방법
 *  1) 스프레드시트 상단 메뉴 "확장 프로그램 > Apps Script" 를 열고,
 *     기본 생성된 코드를 지운 뒤 이 파일 전체 내용을 붙여넣습니다.
 *  2) 함수 선택 드롭다운에서 setupTrigger 를 고르고 ▶ 실행 → 최초 1회 권한 승인.
 *     (단순 onEdit(e)는 외부 요청 권한이 없어 반드시 이 설치형 트리거가 필요합니다.)
 *  3) 기존에 이미 입력돼 있던 행들도 앱에 반영하려면 backfillAll 을 한 번 실행합니다.
 *  4) 이후로는 "전화구매건" 탭에 값을 입력/수정할 때마다 자동으로 앱에 반영됩니다.
 *
 * 주의: 설치 이후 이 시트를 편집하면 실제 운영 앱(Supabase)에 즉시 반영됩니다.
 *       테스트는 설치 전이거나, 별도 테스트용 시트/행으로 진행해주세요.
 */

const SHEET_NAME = '전화구매건';
const SUPABASE_URL = 'https://ywbekolvslixidpugepr.supabase.co';
// index.html에 이미 공개돼 있는 anon key와 동일 (이 앱은 클라이언트가 직접 쓰기까지 수행하는 구조)
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3YmVrb2x2c2xpeGlkcHVnZXByIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU5OTk5ODAsImV4cCI6MjA5MTU3NTk4MH0.gPp4ZNC-uoVuSG0bmfwJyNDZ5MPMArg81aK4wdxAYfs';
const ID_COL_HEADER = '_ID';   // 시트 맨 끝에 자동으로 추가되는 숨은 고유키 컬럼

// 시트 헤더명 → 앱 필드명 매핑. 열 순서가 바뀌어도 헤더명 기준으로 찾으므로 안전합니다.
const FIELD_MAP = {
  '거래구분': 'category',        // 구매 / 누락 / 불량 / 파손
  '담당자': 'staff',
  '날짜': 'date',
  '수취인': 'receiver',
  '수취인연락처1': 'phone1',
  '수취인연락처2': 'phone2',
  '기본주소': 'addr',
  '상품명': 'productName',
  '수량': 'qty',
  '배송방법': 'shipMethod',
  '입금구분': 'payType',
  '배송메모': 'shipMemo',
  '패밀리상품코드': 'familyCode',
  '총 금액': 'amount',
  '입금여부': 'paidStatus',       // 미입금 / 입금완료
  '계산서 발급여부': 'invoiceStatus',
  '비고란': 'note'
};

// ── 1회 실행: 설치형 onEdit 트리거 등록 ──
function setupTrigger(){
  ScriptApp.getProjectTriggers().forEach(t=>{
    if(t.getHandlerFunction() === 'onEditInstallable') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onEditInstallable')
    .forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet())
    .onEdit()
    .create();
  Logger.log('설치 완료: 이제 전화구매건 탭 수정 시 자동으로 앱에 반영됩니다.');
}

// ── 실제 편집 트리거 핸들러 ──
function onEditInstallable(e){
  try{
    const sheet = e.range.getSheet();
    if(sheet.getName() !== SHEET_NAME) return;
    const row = e.range.getRow();
    if(row === 1) return;   // 헤더 행은 무시
    // 완전히 빈 행이면(예: 실수로 클릭) 건너뜀
    const rowVals = sheet.getRange(row,1,1,sheet.getLastColumn()).getValues()[0];
    if(rowVals.every(v=>v==='' || v==null)) return;
    pushRow_(sheet, row);
  }catch(err){
    console.error('onEditInstallable 실패: ' + err);
  }
}

// ── 기존에 이미 입력돼 있던 행 전체를 한 번에 반영 (설치 직후 1회 실행 권장) ──
function backfillAll(){
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  const last = sheet.getLastRow();
  let sent = 0;
  for(let row=2; row<=last; row++){
    const rowVals = sheet.getRange(row,1,1,sheet.getLastColumn()).getValues()[0];
    if(rowVals.every(v=>v==='' || v==null)) continue;
    pushRow_(sheet, row);
    sent++;
    Utilities.sleep(150);   // Supabase 요청 폭주 방지
  }
  Logger.log('백필 완료: ' + sent + '건 전송');
}

// ── 한 행을 읽어서 Supabase work_calendar에 upsert ──
function pushRow_(sheet, row){
  let headers = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
  let idCol = headers.indexOf(ID_COL_HEADER) + 1;
  if(idCol === 0){
    idCol = sheet.getLastColumn() + 1;
    sheet.getRange(1, idCol).setValue(ID_COL_HEADER);
    headers = sheet.getRange(1,1,1,idCol).getValues()[0];
  }
  let id = sheet.getRange(row, idCol).getValue();
  if(!id){
    id = 'po_' + Utilities.getUuid().replace(/-/g,'').slice(0,16);
    sheet.getRange(row, idCol).setValue(id);
  }

  const values = sheet.getRange(row,1,1,headers.length).getValues()[0];
  const data = { id: id };
  headers.forEach((h, i)=>{
    const field = FIELD_MAP[h];
    if(!field) return;
    let v = values[i];
    if(v instanceof Date){
      v = Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    }
    data[field] = v;
  });

  const payload = {
    person: '__app__',
    kind: id,               // id 자체가 'po_'로 시작하므로 그대로 kind로 사용 (앱은 kind LIKE 'po\_%'로 조회)
    data: data,
    updated_at: new Date().toISOString()
  };

  const res = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/work_calendar?on_conflict=person,kind', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  if(res.getResponseCode() >= 300){
    console.error('Supabase 저장 실패 (row ' + row + '): ' + res.getResponseCode() + ' ' + res.getContentText());
  }
}
