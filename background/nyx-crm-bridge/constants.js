// ============================================================
// NYX CRM BRIDGE — Constants & Configuration
// ============================================================

export const NYX_PROJECT_ID = 'nyx-app-998b2';
export const NYX_API_KEY = 'AIzaSyB49rt1oYgre4pNgfD9SRnKatCeFQJSWPY';
export const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${NYX_PROJECT_ID}/databases/(default)/documents`;
export const AUTH_URL = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${NYX_API_KEY}`;
export const REFRESH_URL = `https://securetoken.googleapis.com/v1/token?key=${NYX_API_KEY}`;
export const MFA_FINALIZE_URL = `https://identitytoolkit.googleapis.com/v2/accounts/mfaSignIn:finalize?key=${NYX_API_KEY}`;

export const STORAGE_BUCKET = 'nyx-app-998b2.firebasestorage.app';
export const STORAGE_UPLOAD_BASE = `https://firebasestorage.googleapis.com/upload/storage/v1/b/${STORAGE_BUCKET}/o`;

export const HEARTBEAT_INTERVAL = 30_000;       // 30 seconds
export const COMMAND_POLL_INTERVAL = 2_000;      // 2 seconds — faster command pickup for near-realtime feel
export const DRAFT_SYNC_INTERVAL = 2_000;        // 2 seconds — fast loop for real-time typing
export const ALARM_NAME = 'nyx-crm-keepalive';
export const ALARM_PERIOD_MINUTES = 0.4;         // ~24 seconds (Chrome allows < 1 min for unpacked dev extensions)
