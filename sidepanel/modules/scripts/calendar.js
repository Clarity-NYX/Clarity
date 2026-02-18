// ============================================================
// SCRIPTS MODULE - CALENDAR TIMELINE VIEW
// Shows scripts based on SUBSCRIBER DAY with exact time settings
// Single day view with navigation arrows
// ============================================================

import Store from '../../state/store.js';
import { $, escapeHtml } from '../../utils/dom.js';

// Calendar configuration
const HOUR_STEP = 2;     // 2-hour increments
const DEFAULT_DURATION = 1.5; // Default 1.5 hours if no end time set

// Block types
const BLOCK_TYPES = {
  SCRIPT: 'script',
  BREAK: 'break'
};

// State
let currentDisplayDay = 1;
let nowIndicatorInterval = null;

// ============================================================
// HELPERS
// ============================================================

const parseTime = (timeStr) => {
  if (!timeStr) return null;
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours + (minutes || 0) / 60;
};

const formatHourLabel = (hour) => {
  const h = Math.floor(hour % 24);
  const m = Math.round((hour % 1) * 60);
  if (h === 0) return m ? `12:${m.toString().padStart(2,'0')}AM` : '12AM';
  if (h === 12) return m ? `12:${m.toString().padStart(2,'0')}PM` : '12PM';
  if (h < 12) return m ? `${h}:${m.toString().padStart(2,'0')}AM` : `${h}AM`;
  return m ? `${h-12}:${m.toString().padStart(2,'0')}PM` : `${h-12}PM`;
};

const getProfileSchedule = () => {
  const profile = Store.get('currentProfile');
  const schedule = profile?.schedule || {};
  
  let wakeUp = parseTime(schedule.wakeUpTime) ?? 8;
  let sleep = parseTime(schedule.sleepTime) ?? 23;
  
  // Handle overnight schedules (sleep time 00:00-06:00 means next day)
  if (sleep <= 6 && wakeUp >= 6) {
    sleep = sleep + 24;
  }
  
  wakeUp = Math.max(0, wakeUp);
  sleep = Math.max(wakeUp + 1, sleep);
  
  return { wakeUp, sleep };
};

const getCalendarHours = () => {
  const schedule = getProfileSchedule();
  // Use exact hours, just floor the wake up and ceil the sleep for display
  let start = Math.floor(schedule.wakeUp);
  let end = Math.ceil(schedule.sleep);
  
  // Ensure minimum range of 4 hours
  if (end - start < 4) end = start + 8;
  
  const total = end - start;
  return { start, end, total: Math.max(total, 4) };
};

// ============================================================
// MODAL CONTROL
// ============================================================

export const openCalendarModal = () => {
  const modal = $('calendarModal');
  if (modal) {
    currentDisplayDay = 1; // Reset to Day 1 when opening
    modal.classList.remove('hidden');
    renderCalendar();
    startNowIndicatorUpdate();
  }
};

export const closeCalendarModal = () => {
  const modal = $('calendarModal');
  if (modal) {
    modal.classList.add('hidden');
    stopNowIndicatorUpdate();
  }
};

// ============================================================
// NAVIGATION
// ============================================================

const prevDay = () => {
  if (currentDisplayDay > 1) {
    currentDisplayDay--;
    renderCalendar();
  }
};

const nextDay = () => {
  currentDisplayDay++;
  renderCalendar();
};

// ============================================================
// NOW INDICATOR
// ============================================================

const startNowIndicatorUpdate = () => {
  updateNowIndicator();
  nowIndicatorInterval = setInterval(updateNowIndicator, 60000);
};

const stopNowIndicatorUpdate = () => {
  if (nowIndicatorInterval) {
    clearInterval(nowIndicatorInterval);
    nowIndicatorInterval = null;
  }
};

const updateNowIndicator = () => {
  const hours = getCalendarHours();
  const now = new Date();
  const currentHour = now.getHours() + now.getMinutes() / 60;
  
  // Only show on Day 1
  if (currentDisplayDay !== 1 || currentHour < hours.start || currentHour > hours.end) {
    const indicator = $('nowIndicator');
    if (indicator) indicator.classList.add('hidden');
    return;
  }
  
  const position = ((currentHour - hours.start) / hours.total) * 100;
  
  const indicator = $('nowIndicator');
  if (indicator) {
    indicator.style.top = `${position}%`;
    indicator.classList.remove('hidden');
  }
  
  const timeLabel = indicator?.querySelector('.now-time');
  if (timeLabel) {
    timeLabel.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
};

// ============================================================
// CALENDAR RENDERING
// ============================================================

export const renderCalendar = () => {
  const container = $('calendarGrid');
  if (!container) return;
  
  const schedule = getProfileSchedule();
  const hours = getCalendarHours();
  
  const hourLabelsHtml = generateHourLabels(hours);
  const dayColumnHtml = generateDayColumn(currentDisplayDay, currentDisplayDay === 1, hours, schedule);
  
  container.innerHTML = `
    <div class="calendar-nav">
      <button class="calendar-nav-btn ${currentDisplayDay === 1 ? 'disabled' : ''}" id="calendarPrevBtn" ${currentDisplayDay === 1 ? 'disabled' : ''}>
        ‹
      </button>
      <div class="calendar-day-title">
        <span class="day-number">DAY ${currentDisplayDay}</span>
        <span class="day-badge ${currentDisplayDay === 1 ? '' : 'preview'}">${currentDisplayDay === 1 ? 'Current' : 'Preview'}</span>
      </div>
      <button class="calendar-nav-btn" id="calendarNextBtn">
        ›
      </button>
    </div>
    <div class="calendar-body">
      <div class="calendar-hours">${hourLabelsHtml}</div>
      <div class="calendar-columns single">
        ${dayColumnHtml}
        <div id="nowIndicator" class="now-indicator hidden">
          <span class="now-time"></span>
          <div class="now-line"></div>
        </div>
      </div>
    </div>
  `;
  
  // Add navigation listeners
  $('calendarPrevBtn')?.addEventListener('click', prevDay);
  $('calendarNextBtn')?.addEventListener('click', nextDay);
  
  updateNowIndicator();
};

const generateHourLabels = (hours) => {
  let html = '';
  for (let hour = hours.start; hour < hours.end; hour += HOUR_STEP) {
    html += `<div class="calendar-hour-label">${formatHourLabel(hour)}</div>`;
  }
  return html;
};

const generateDayColumn = (subscriberDay, isToday, hours, schedule) => {
  const timeline = calculateDayTimeline(subscriberDay, hours, schedule);
  
  let cellsHtml = '';
  for (let hour = hours.start; hour < hours.end; hour += HOUR_STEP) {
    cellsHtml += `<div class="calendar-cell" data-hour="${hour}"></div>`;
  }
  
  const blocksHtml = timeline.map(block => generateTimeBlock(block, hours)).join('');
  
  return `
    <div class="calendar-column single ${isToday ? 'today' : ''}" data-day="${subscriberDay}">
      <div class="calendar-cells">${cellsHtml}</div>
      <div class="calendar-blocks">${blocksHtml}</div>
    </div>
  `;
};

const generateTimeBlock = (block, hours) => {
  const visibleStart = Math.max(block.startHour, hours.start);
  const visibleEnd = Math.min(block.endHour, hours.end);
  
  if (visibleEnd <= visibleStart) return '';
  
  const top = ((visibleStart - hours.start) / hours.total) * 100;
  const height = ((visibleEnd - visibleStart) / hours.total) * 100;
  
  let content = '';
  if (block.type === BLOCK_TYPES.SCRIPT) {
    const timeStr = `${formatHourLabel(block.startHour)}-${formatHourLabel(block.endHour)}`;
    content = `
      <div class="block-name">${escapeHtml(block.name)}</div>
      <div class="block-time">${timeStr}</div>
    `;
  } else if (block.type === BLOCK_TYPES.BREAK) {
    content = `<div class="block-name">☕</div>`;
  }
  
  return `
    <div class="calendar-block block-${block.type}" style="top: ${top}%; height: ${height}%;" title="${block.name || block.type}">
      ${content}
    </div>
  `;
};

// ============================================================
// TIMELINE CALCULATION
// ============================================================

const calculateDayTimeline = (subscriberDay, hours, schedule) => {
  const scripts = Store.get('scripts') || [];
  
  const dayScripts = scripts
    .filter(s => {
      const subDay = s.timingSettings?.subscriberDay;
      return !subDay || subDay === subscriberDay;
    })
    .sort((a, b) => (a.timingSettings?.order ?? 999) - (b.timingSettings?.order ?? 999));
  
  const timeline = [];
  const events = [];
  
  for (const script of dayScripts) {
    const settings = script.timingSettings || {};
    
    let startHour = parseTime(settings.notBeforeTime) || schedule.wakeUp;
    let endHour = parseTime(settings.notAfterTime);
    
    // Handle overnight script times (00:00-06:00 means next day)
    if (endHour !== null && endHour <= 6 && startHour >= 6) {
      endHour = endHour + 24; // Convert to next-day hours (01:00 -> 25)
    }
    
    if (!endHour) endHour = startHour + DEFAULT_DURATION;
    
    // Clamp to wake/sleep bounds
    startHour = Math.max(startHour, schedule.wakeUp);
    endHour = Math.min(endHour, schedule.sleep);
    
    if (endHour > startHour) {
      events.push({
        type: BLOCK_TYPES.SCRIPT,
        name: script.name,
        startHour,
        endHour,
        breakMins: settings.minMinutes || 30
      });
    }
  }
  
  events.sort((a, b) => a.startHour - b.startHour);
  
  let currentHour = schedule.wakeUp;
  
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    
    if (event.startHour > currentHour) {
      timeline.push({
        type: BLOCK_TYPES.BREAK,
        name: 'Free time',
        startHour: currentHour,
        endHour: event.startHour
      });
    }
    
    timeline.push({
      type: BLOCK_TYPES.SCRIPT,
      name: event.name,
      startHour: event.startHour,
      endHour: event.endHour
    });
    
    currentHour = event.endHour;
    
    if (i < events.length - 1) {
      const breakEnd = Math.min(currentHour + event.breakMins / 60, schedule.sleep);
      if (breakEnd > currentHour) {
        timeline.push({
          type: BLOCK_TYPES.BREAK,
          name: 'Break',
          startHour: currentHour,
          endHour: breakEnd
        });
        currentHour = breakEnd;
      }
    }
  }
  
  if (currentHour < schedule.sleep) {
    timeline.push({
      type: BLOCK_TYPES.BREAK,
      name: 'Free time',
      startHour: currentHour,
      endHour: schedule.sleep
    });
  }
  
  return timeline;
};

// ============================================================
// EVENT LISTENERS
// ============================================================

export const setupCalendarListeners = () => {
  $('calendarBtn')?.addEventListener('click', openCalendarModal);
  $('closeCalendarModalBtn')?.addEventListener('click', closeCalendarModal);
  
  $('calendarModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'calendarModal') {
      closeCalendarModal();
    }
  });
};
