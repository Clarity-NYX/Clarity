// ============================================================
// NYX CRM BRIDGE — Firestore REST API Helpers
// ============================================================

import { NYX_PROJECT_ID, FIRESTORE_BASE } from './constants.js';
import { getToken } from './auth.js';

/** Convert JS value to Firestore Value format */
export function toFirestoreValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'string') return { stringValue: val };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  }
  if (val instanceof Date) return { timestampValue: val.toISOString() };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFirestoreValue) } };
  if (typeof val === 'object') {
    const fields = {};
    for (const [k, v] of Object.entries(val)) fields[k] = toFirestoreValue(v);
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

/** Build Firestore document body from a plain object */
export function buildDoc(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) fields[k] = toFirestoreValue(v);
  }
  return { fields };
}

/** PATCH a Firestore document (create or update) */
export async function patchDoc(path, data) {
  const token = await getToken();
  if (!token) return null;

  const fields = Object.keys(data);
  const masks = fields.map(f => `updateMask.fieldPaths=${f}`).join('&');
  const url = `${FIRESTORE_BASE}/${path}?${masks}`;

  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(buildDoc(data)),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.warn(`[NYX CRM] PATCH ${path} failed:`, res.status, err.error?.message || '');
    return null;
  }
  return res.json();
}

/** Run a structured query (for filtering commands by status) */
export async function runQuery(parentPath, collectionId, filters) {
  const token = await getToken();
  if (!token) return [];

  const url = `${FIRESTORE_BASE}/${parentPath}:runQuery`;
  const structuredQuery = {
    from: [{ collectionId }],
    where: {
      compositeFilter: {
        op: 'AND',
        filters: filters.map(f => ({
          fieldFilter: {
            field: { fieldPath: f.field },
            op: f.op || 'EQUAL',
            value: toFirestoreValue(f.value),
          },
        })),
      },
    },
    limit: 10,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ structuredQuery }),
  });

  if (!res.ok) return [];
  const results = await res.json();
  return results.filter(r => r.document).map(r => {
    const doc = r.document;
    const id = doc.name.split('/').pop();
    const fields = {};
    if (doc.fields) {
      for (const [k, v] of Object.entries(doc.fields)) {
        fields[k] = extractValue(v);
      }
    }
    return { id, ...fields, _name: doc.name };
  });
}

/** List ALL documents in a Firestore collection, paginating through all pages. */
export async function listDocs(collectionPath) {
  const allDocs = [];
  let pageToken = null;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const token = await getToken();
    if (!token) return allDocs;

    let url = `${FIRESTORE_BASE}/${collectionPath}?pageSize=300`;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;

    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) break;
      const data = await res.json();
      if (data.documents) {
        for (const doc of data.documents) {
          const id = doc.name.split('/').pop();
          allDocs.push({ id, _name: doc.name });
        }
      }
      if (data.nextPageToken) {
        pageToken = data.nextPageToken;
      } else {
        break;
      }
    } catch {
      break;
    }
  }

  return allDocs;
}

/** GET a single Firestore document by path — returns parsed fields object or null */
export async function getDoc(docPath) {
  const token = await getToken();
  if (!token) return null;
  const url = `${FIRESTORE_BASE}/${docPath}`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.fields) return null;
    const fields = {};
    for (const [k, v] of Object.entries(data.fields)) fields[k] = extractValue(v);
    return fields;
  } catch { return null; }
}

/** Delete a single Firestore document by path */
export async function deleteDoc(docPath) {
  const token = await getToken();
  if (!token) return false;

  const url = `${FIRESTORE_BASE}/${docPath}`;
  try {
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

/** Firestore batchWrite — up to 500 writes in a single HTTP request. */
export async function batchWrite(operations) {
  if (!operations?.length) return 0;

  const BATCH_LIMIT = 500;
  const docNamePrefix = `projects/${NYX_PROJECT_ID}/databases/(default)/documents`;
  let committed = 0;

  for (let i = 0; i < operations.length; i += BATCH_LIMIT) {
    const chunk = operations.slice(i, i + BATCH_LIMIT);
    const token = await getToken();
    if (!token) break;

    const writes = chunk.map(op => {
      if (op.delete) {
        return { delete: `${docNamePrefix}/${op.delete}` };
      }
      if (op.update) {
        const fields = {};
        const fieldPaths = [];
        for (const [k, v] of Object.entries(op.update.data)) {
          if (v !== undefined) {
            fields[k] = toFirestoreValue(v);
            fieldPaths.push(k);
          }
        }
        return {
          update: {
            name: `${docNamePrefix}/${op.update.path}`,
            fields,
          },
          updateMask: { fieldPaths },
        };
      }
      return null;
    }).filter(Boolean);

    if (writes.length === 0) continue;

    try {
      const url = `https://firestore.googleapis.com/v1/projects/${NYX_PROJECT_ID}/databases/(default)/documents:batchWrite`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ writes }),
      });

      if (res.ok) {
        const result = await res.json();
        const writeResults = result.writeResults || [];
        const successes = writeResults.filter(wr => !wr.status || wr.status.code === 0).length;
        const failures = writeResults.filter(wr => wr.status && wr.status.code !== 0);
        committed += successes;
        if (failures.length > 0) {
          console.warn(`[NYX CRM] batchWrite partial failure: ${successes}/${writeResults.length} succeeded, ${failures.length} failed. First error:`, JSON.stringify(failures[0].status));
        }
      } else {
        const errBody = await res.text().catch(() => '');
        console.error(`[NYX CRM] ❌ batchWrite HTTP ${res.status} (${chunk.length} ops). Path sample: ${chunk[0]?.update?.path || chunk[0]?.delete || 'unknown'}. Response: ${errBody.slice(0, 500)}`);
      }
    } catch (e) {
      console.warn(`[NYX CRM] batchWrite error:`, e.message);
    }
  }

  return committed;
}

/** Delete all documents in a Firestore collection. */
export async function deleteCollection(collectionPath) {
  const docs = await listDocs(collectionPath);
  if (docs.length === 0) return 0;

  const CONCURRENCY = 10;
  let deleted = 0;
  let failed = 0;

  for (let i = 0; i < docs.length; i += CONCURRENCY) {
    const batch = docs.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(doc => deleteDoc(`${collectionPath}/${doc.id}`))
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) deleted++;
      else failed++;
    }
  }

  if (failed > 0) {
    console.warn(`[NYX CRM] 🗑️ deleteCollection: ${deleted} deleted, ${failed} FAILED out of ${docs.length} in ${collectionPath}`);
  } else {
    console.log(`[NYX CRM] 🗑️ Deleted ${deleted}/${docs.length} docs from ${collectionPath}`);
  }
  return deleted;
}

/** Extract plain JS value from Firestore Value */
export function extractValue(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(extractValue);
  if ('mapValue' in v) {
    const obj = {};
    for (const [k, fv] of Object.entries(v.mapValue.fields || {})) obj[k] = extractValue(fv);
    return obj;
  }
  return null;
}

