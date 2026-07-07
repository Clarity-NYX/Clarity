// ============================================================
// NYX CRM BRIDGE — Firebase Auth (REST API)
// ============================================================

import { AUTH_URL, MFA_FINALIZE_URL, REFRESH_URL } from './constants.js';
import { S } from './state.js';

/** Sign in to NYX Firebase and get an idToken */
export async function signIn(email, password) {
  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'NYX auth failed');

  // Firebase MFA challenge: response has mfaPendingCredential but no idToken
  if (data.mfaPendingCredential || !data.idToken) {
    const mfaEnrollmentId = data.mfaInfo?.[0]?.mfaEnrollmentId || null;
    return {
      mfaRequired: true,
      mfaPendingCredential: data.mfaPendingCredential,
      mfaEnrollmentId,
      mfaDisplayName: data.mfaInfo?.[0]?.displayName || 'TOTP',
    };
  }

  S.nyxIdToken = data.idToken;
  S.nyxRefreshToken = data.refreshToken;
  S.nyxTokenExpiry = Date.now() + (parseInt(data.expiresIn, 10) * 1000) - 60_000;
  await persistRefreshToken();
  console.log('[NYX CRM] ✅ Authenticated with NYX Firebase');
  return { mfaRequired: false };
}

/** Finalize MFA sign-in with TOTP verification code. */
export async function finalizeMfaSignIn(mfaPendingCredential, mfaEnrollmentId, totpCode) {
  const res = await fetch(MFA_FINALIZE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mfaPendingCredential,
      mfaEnrollmentId,
      totpVerificationInfo: { verificationCode: totpCode },
    }),
  });
  const data = await res.json();
  if (data.error) {
    const msg = data.error.message || 'MFA verification failed';
    throw new Error(msg.includes('INVALID') ? 'Invalid 2FA code. Please try again.' : msg);
  }
  if (!data.idToken) throw new Error('MFA verification did not return a token');

  S.nyxIdToken = data.idToken;
  S.nyxRefreshToken = data.refreshToken;
  S.nyxTokenExpiry = Date.now() + (parseInt(data.expiresIn, 10) * 1000) - 60_000;
  await persistRefreshToken();
  console.log('[NYX CRM] ✅ MFA verified — authenticated with NYX Firebase');
  return true;
}

/** Refresh the idToken using the refreshToken */
export async function refreshToken() {
  if (!S.nyxRefreshToken) return false;
  try {
    const res = await fetch(REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: S.nyxRefreshToken }),
    });
    const data = await res.json();
    if (data.error) { console.warn('[NYX CRM] Token refresh failed:', data.error); return false; }
    S.nyxIdToken = data.id_token;
    S.nyxRefreshToken = data.refresh_token;
    S.nyxTokenExpiry = Date.now() + (parseInt(data.expires_in, 10) * 1000) - 60_000;
    await persistRefreshToken();
    return true;
  } catch (e) {
    console.warn('[NYX CRM] Token refresh error:', e.message);
    return false;
  }
}

/** Persist refresh token to storage for service worker restarts */
export async function persistRefreshToken() {
  if (S.nyxRefreshToken) {
    try { await chrome.storage.local.set({ nyxCrmRefreshToken: S.nyxRefreshToken }); }
    catch (e) { /* silent */ }
  }
}

/** Get a valid idToken (auto-refresh if expired) */
export async function getToken() {
  if (!S.nyxIdToken) return null;
  if (Date.now() > S.nyxTokenExpiry) {
    const ok = await refreshToken();
    if (!ok) return null;
  }
  return S.nyxIdToken;
}

