// ============================================================
// NYX CRM BRIDGE — Utility Functions
// ============================================================

/** Normalize any timestamp value to a valid ISO string. */
export function normalizeTimestamp(val) {
  if (!val) return null;

  let date;

  if (typeof val === 'number') {
    date = new Date(val > 1e12 ? val : val * 1000);
  } else if (typeof val === 'string') {
    const num = Number(val);
    if (!isNaN(num) && val.trim().length > 0 && /^\d+$/.test(val.trim())) {
      date = new Date(num > 1e12 ? num : num * 1000);
    } else {
      let cleaned = val.replace(/\s+at\s+/i, ' ');
      cleaned = cleaned.replace(/^[A-Za-z]+,\s*/, '');
      date = new Date(cleaned);
    }
  } else if (val instanceof Date) {
    date = val;
  } else if (val?.toDate) {
    date = val.toDate();
  } else if (val?.seconds) {
    date = new Date(val.seconds * 1000);
  } else {
    date = new Date(val);
  }

  if (!date || isNaN(date.getTime()) || date.getFullYear() < 2020) {
    return null;
  }

  const ONE_DAY = 86400_000;
  if (date.getTime() > Date.now() + ONE_DAY) {
    date.setFullYear(date.getFullYear() - 1);
  }

  return date.toISOString();
}

/** Estimate a timestamp from a display-text string like "5:06 pm", "2h", "Yesterday", "Sep 12". */
export function estimateTimestampFromDisplay(timeText) {
  if (!timeText) return null;
  const now = Date.now();
  const text = timeText.toLowerCase().trim();

  const minutesMatch = text.match(/^(\d+)\s*m$/);
  if (minutesMatch) return now - (parseInt(minutesMatch[1]) * 60_000);

  const hoursMatch = text.match(/^(\d+)\s*h$/);
  if (hoursMatch) return now - (parseInt(hoursMatch[1]) * 3600_000);

  if (text.includes('yesterday')) return now - 86400_000;

  const daysMatch = text.match(/^(\d+)\s*d$/);
  if (daysMatch) return now - (parseInt(daysMatch[1]) * 86400_000);

  const months = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
  const dateMatch1 = text.match(/^([a-z]{3})\s+(\d{1,2})$/);
  const dateMatch2 = text.match(/^(\d{1,2})\s+([a-z]{3})$/);
  let monthNum = null, dayNum = null;
  if (dateMatch1 && months[dateMatch1[1]] !== undefined) {
    monthNum = months[dateMatch1[1]]; dayNum = parseInt(dateMatch1[2]);
  } else if (dateMatch2 && months[dateMatch2[2]] !== undefined) {
    monthNum = months[dateMatch2[2]]; dayNum = parseInt(dateMatch2[1]);
  }
  if (monthNum !== null && dayNum) {
    const cur = new Date();
    let year = cur.getFullYear();
    const candidate = new Date(year, monthNum, dayNum, 12, 0, 0);
    if (candidate.getTime() > now) year--;
    return new Date(year, monthNum, dayNum, 12, 0, 0).getTime();
  }

  const timeMatch = text.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1]);
    const mins = parseInt(timeMatch[2]);
    const ampm = timeMatch[3];
    if (ampm === 'pm' && hours < 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
    const today = new Date();
    today.setHours(hours, mins, 0, 0);
    return today.getTime();
  }

  return null;
}

/** Parse a spent string like "$1,234.56" to a number */
export function parseSpentAmount(val) {
  if (!val && val !== 0) return 0;
  if (typeof val === 'number') return val;
  const cleaned = String(val).replace(/[^0-9.]/g, '');
  return parseFloat(cleaned) || 0;
}

