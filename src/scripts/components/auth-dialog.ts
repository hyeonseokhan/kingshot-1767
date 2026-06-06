/**
 * 전역 인증 다이얼로그 클라이언트 로직.
 *
 * 트리거: document 의 'app-open-auth' 커스텀 이벤트.
 * EF: tile-match-auth (action: pin-status / verify-pin / set-pin) — members 테이블 기반.
 *
 * 상태 흐름:
 *   id-input → (pin-status) → pin-input
 *     - 등록됨(registered:true)  → verify-pin → 저장 + 닫기
 *     - 미등록(registered:false) → set-pin    → 저장 + 닫기
 *
 * 저장 키: 'pnx-mb-auth-v1' (KvK 설문의 'pnx-sk-auth-v1' 과 완전 분리).
 * 저장 형식: { record: { kingshot_id, nickname, is_admin } }
 *
 * 대상: PNX 서버 members 테이블 등록 회원 전용.
 * KvK 설문 참여는 설문 페이지의 자체 인증 흐름 사용.
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@/lib/shared/supabase';

const AUTH_KEY = 'pnx-mb-auth-v1';
const FN_URL = SUPABASE_URL + '/functions/v1/tile-match-auth';

interface PlayerInfo {
  kingshot_id: string;
  nickname: string;
  profile_photo: string | null;
}
interface PinStatusResp {
  ok: boolean;
  error?: string;
  nickname?: string;
  profile_photo?: string | null;
  registered?: boolean;
  is_admin?: boolean;
}
interface PinActionResp {
  ok: boolean;
  error?: string;
  is_admin?: boolean;
}

async function callFn<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(FN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return (await res.json()) as T;
}

function mapError(code: string | undefined): string {
  const map: Record<string, string> = {
    member_not_found: 'PNX 서버 등록 회원이 아닙니다. 회원 목록을 확인해 주세요.',
    missing_player_id: '올바른 킹샷 ID 가 아닙니다.',
    invalid_pin: 'PIN 이 일치하지 않거나 형식이 올바르지 않습니다.',
    already_registered: '이미 PIN 이 등록되어 있습니다. 기존 PIN 으로 로그인해 주세요.',
    not_registered: 'PIN 이 등록되지 않았습니다. 새 PIN 을 설정해 주세요.',
    rate_limited: '요청이 너무 잦습니다. 잠시 후 다시 시도해주세요.',
  };
  return map[code ?? ''] ?? '일시적인 문제가 발생했어요. 잠시 후 다시 시도해주세요.';
}

function init(): void {
  const dlg = document.getElementById('app-auth-dialog') as HTMLDialogElement | null;
  if (!dlg) return;

  const idInput = document.getElementById('app-auth-id-input') as HTMLInputElement;
  const idSearchBtn = document.getElementById('app-auth-id-search') as HTMLButtonElement;
  const idStatus = document.getElementById('app-auth-id-status') as HTMLElement;
  const pinInput = document.getElementById('app-auth-pin-input') as HTMLInputElement;
  const pinBoxes = document
    .querySelector('.app-auth-pin-boxes')
    ?.querySelectorAll<HTMLElement>('.app-auth-pin-box') ?? null;
  const pinStatus = document.getElementById('app-auth-pin-status') as HTMLElement;
  const backBtn = document.getElementById('app-auth-back') as HTMLButtonElement;
  const closeBtn = document.getElementById('app-auth-close') as HTMLButtonElement;
  const stepId = document.getElementById('app-auth-step-id') as HTMLElement;
  const stepPin = document.getElementById('app-auth-step-pin') as HTMLElement;
  const modeBanner = document.getElementById('app-auth-mode-banner') as HTMLElement;
  const pinHelp = document.getElementById('app-auth-pin-help') as HTMLElement;
  const playerName = document.getElementById('app-auth-player-name') as HTMLElement;
  const playerId = document.getElementById('app-auth-player-id') as HTMLElement;
  const photo = document.getElementById('app-auth-photo') as HTMLImageElement;
  const photoEmpty = document.getElementById('app-auth-photo-empty') as HTMLElement;

  let currentPlayer: PlayerInfo | null = null;
  let currentMode: 'login' | 'register' = 'login';

  function showStep(step: 'id' | 'pin'): void {
    stepId.hidden = step !== 'id';
    stepPin.hidden = step !== 'pin';
  }

  function setMode(mode: 'login' | 'register'): void {
    currentMode = mode;
    modeBanner.hidden = mode !== 'register';
    pinHelp.textContent =
      mode === 'register'
        ? '사용하실 PIN 4자리를 입력해 주세요. (이 PIN 으로 다음부터 로그인합니다)'
        : '등록한 PIN 4자리를 입력해 주세요.';
  }

  function setStatus(el: HTMLElement, msg: string, tone: '' | 'err' | 'ok' = ''): void {
    el.textContent = msg;
    el.className = 'app-auth-status' + (tone ? ' is-' + tone : '');
  }

  function syncPinBoxes(): void {
    if (!pinBoxes) return;
    const len = pinInput.value.length;
    pinBoxes.forEach((box, i) => {
      box.classList.toggle('is-filled', i < len);
      box.classList.toggle('is-active', i === len && document.activeElement === pinInput);
      box.textContent = i < len ? '•' : '';
    });
  }

  function reset(): void {
    idInput.value = '';
    pinInput.value = '';
    setStatus(idStatus, '');
    setStatus(pinStatus, '');
    currentPlayer = null;
    setMode('login');
    syncPinBoxes();
    showStep('id');
  }

  function close(): void {
    if (dlg!.open) dlg!.close();
    reset();
  }

  function fillPlayerCard(player: PlayerInfo): void {
    playerName.textContent = player.nickname;
    playerId.textContent = `#${player.kingshot_id}`;
    if (player.profile_photo) {
      photo.src = player.profile_photo;
      photo.hidden = false;
      photoEmpty.style.display = 'none';
    } else {
      photo.hidden = true;
      photoEmpty.style.display = '';
      photoEmpty.textContent = (player.nickname || '?').charAt(0);
    }
  }

  async function onSearchId(): Promise<void> {
    const id = idInput.value.trim();
    if (!/^\d{4,15}$/.test(id)) {
      setStatus(idStatus, '4~15자리 숫자로 입력해 주세요.', 'err');
      return;
    }
    idSearchBtn.disabled = true;
    setStatus(idStatus, '');
    try {
      const json = await callFn<PinStatusResp>({ action: 'pin-status', player_id: id });
      if (!json.ok || !json.nickname) {
        setStatus(idStatus, mapError(json.error), 'err');
        return;
      }
      currentPlayer = { kingshot_id: id, nickname: json.nickname, profile_photo: json.profile_photo ?? null };
      setMode(json.registered ? 'login' : 'register');
      fillPlayerCard(currentPlayer);
      showStep('pin');
      setTimeout(() => pinInput.focus(), 50);
    } catch (err) {
      setStatus(idStatus, '네트워크 오류: ' + (err as Error).message, 'err');
    } finally {
      idSearchBtn.disabled = false;
    }
  }

  async function onConfirmPin(): Promise<void> {
    if (!currentPlayer) return;
    const pin = pinInput.value.trim();
    if (!/^\d{4}$/.test(pin)) {
      setStatus(pinStatus, 'PIN 4자리를 입력해 주세요.', 'err');
      return;
    }
    setStatus(pinStatus, '');
    try {
      const action = currentMode === 'register' ? 'set-pin' : 'verify-pin';
      const json = await callFn<PinActionResp>({ action, player_id: currentPlayer.kingshot_id, pin });
      if (!json.ok) {
        setStatus(pinStatus, mapError(json.error), 'err');
        return;
      }
      const record = {
        kingshot_id: currentPlayer.kingshot_id,
        nickname: currentPlayer.nickname,
        avatar_url: currentPlayer.profile_photo,
        is_admin: json.is_admin ?? false,
        pin,
      };
      try {
        localStorage.setItem(AUTH_KEY, JSON.stringify({ record }));
      } catch {
        /* private mode 등 — 무시 */
      }
      document.dispatchEvent(new CustomEvent('app-auth-changed'));
      close();
    } catch (err) {
      setStatus(pinStatus, '네트워크 오류: ' + (err as Error).message, 'err');
    }
  }

  // === 이벤트 와이어업 ===
  document.addEventListener('app-open-auth', () => {
    reset();
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
    setTimeout(() => idInput.focus(), 50);
  });

  idSearchBtn.addEventListener('click', onSearchId);
  idInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onSearchId();
  });

  pinInput.addEventListener('input', () => {
    pinInput.value = pinInput.value.replace(/[^0-9]/g, '').slice(0, 4);
    syncPinBoxes();
    if (pinInput.value.length === 4) onConfirmPin();
  });
  pinInput.addEventListener('focus', syncPinBoxes);
  pinInput.addEventListener('blur', syncPinBoxes);
  pinInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onConfirmPin();
  });

  backBtn?.addEventListener('click', () => {
    pinInput.value = '';
    syncPinBoxes();
    setStatus(pinStatus, '');
    setMode('login');
    showStep('id');
    setTimeout(() => idInput.focus(), 50);
  });

  closeBtn.addEventListener('click', close);
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) close();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
